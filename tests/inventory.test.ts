import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedTenants, cleanupTenants, signInAs, type SeededData } from "./rls/fixtures";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMovements, createMovement } from "@/lib/inventory";

let data: SeededData;
let clubAClient: SupabaseClient;
let clubBClient: SupabaseClient;
const cleanupMoveIds: string[] = [];

beforeAll(async () => {
  data = await seedTenants();
  clubAClient = await signInAs(data.clubA.adminEmail, data.clubA.adminPassword);
  clubBClient = await signInAs(data.clubB.adminEmail, data.clubB.adminPassword);
}, 30000);

afterAll(async () => {
  const admin = createAdminClient();
  if (cleanupMoveIds.length > 0) {
    await admin.from("inventory_moves").delete().in("id", cleanupMoveIds);
  }
  if (data) {
    await cleanupTenants(data);
  }
}, 30000);

describe("getMovements", () => {
  it("returns only the caller's club's movements, not club B's", async () => {
    const movements = await getMovements(clubAClient, data.clubA.clubId);
    const ids = movements.map((m) => m.id);
    expect(ids).toContain(data.clubA.inventoryMoveId);
    expect(ids).not.toContain(data.clubB.inventoryMoveId);
  });

  it("resolves the product name for the fixture's seeded PURCHASE move", async () => {
    const movements = await getMovements(clubAClient, data.clubA.clubId);
    const fixtureMove = movements.find((m) => m.id === data.clubA.inventoryMoveId);
    expect(fixtureMove).toBeDefined();
    expect(fixtureMove!.productName).toBe("Test Product");
    expect(fixtureMove!.type).toBe("PURCHASE");
    expect(fixtureMove!.qty).toBe(100);
  });

  it("filters by type", async () => {
    const movements = await getMovements(clubAClient, data.clubA.clubId, { type: "WASTE" });
    expect(movements.every((m) => m.type === "WASTE")).toBe(true);
  });

  it("filters by productId", async () => {
    const movements = await getMovements(clubAClient, data.clubA.clubId, {
      productId: data.clubA.productId,
    });
    expect(movements.every((m) => m.productId === data.clubA.productId)).toBe(true);
  });
});

describe("createMovement", () => {
  it("normalizes PURCHASE to a positive quantity regardless of entered sign", async () => {
    const { movement, newStock } = await createMovement(clubAClient, data.clubA.clubId, {
      productId: data.clubA.productId,
      type: "PURCHASE",
      qty: -50,
    });
    cleanupMoveIds.push(movement.id);
    expect(movement.qty).toBe(50);
    expect(movement.staffEmail).toBe(data.clubA.adminEmail);
    expect(newStock).toBe(150);
  });

  it("normalizes WASTE to a negative quantity regardless of entered sign", async () => {
    const { movement, newStock } = await createMovement(clubAClient, data.clubA.clubId, {
      productId: data.clubA.productId,
      type: "WASTE",
      qty: 10,
    });
    cleanupMoveIds.push(movement.id);
    expect(movement.qty).toBe(-10);
    expect(newStock).toBe(140);
  });

  it("keeps ADJUSTMENT's entered sign as-is", async () => {
    const { movement, newStock } = await createMovement(clubAClient, data.clubA.clubId, {
      productId: data.clubA.productId,
      type: "ADJUSTMENT",
      qty: -5,
    });
    cleanupMoveIds.push(movement.id);
    expect(movement.qty).toBe(-5);
    expect(newStock).toBe(135);
  });

  it("rejects a zero quantity", async () => {
    await expect(
      createMovement(clubAClient, data.clubA.clubId, {
        productId: data.clubA.productId,
        type: "ADJUSTMENT",
        qty: 0,
      }),
    ).rejects.toThrow();
  });

  it("rejects a product belonging to a different club", async () => {
    await expect(
      createMovement(clubAClient, data.clubA.clubId, {
        productId: data.clubB.productId,
        type: "PURCHASE",
        qty: 10,
      }),
    ).rejects.toThrow("Product not found in this club");
  });
});
