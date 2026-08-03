import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedTenants, cleanupTenants, signInAs, type SeededData } from "./rls/fixtures";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getProducts,
  createProduct,
  updateProduct,
  hasProductHistory,
  deleteOrDeactivateProduct,
} from "@/lib/products";

let data: SeededData;
let clubAClient: SupabaseClient;
let clubBClient: SupabaseClient;
let staffClient: SupabaseClient;
let staffUserId: string;
const STAFF_PASSWORD = "Test-Password-123!";
const cleanupProductIds: string[] = [];

beforeAll(async () => {
  data = await seedTenants();
  clubAClient = await signInAs(data.clubA.adminEmail, data.clubA.adminPassword);
  clubBClient = await signInAs(data.clubB.adminEmail, data.clubB.adminPassword);

  const admin = createAdminClient();
  const staffEmail = `products-staff-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const { data: staffAuth, error: staffAuthError } = await admin.auth.admin.createUser({
    email: staffEmail,
    password: STAFF_PASSWORD,
    email_confirm: true,
  });
  if (staffAuthError) throw staffAuthError;
  staffUserId = staffAuth.user.id;

  const { error: staffMembershipError } = await admin.from("club_users").insert({
    club_id: data.clubA.clubId,
    user_id: staffUserId,
    role: "staff",
  });
  if (staffMembershipError) throw staffMembershipError;

  staffClient = await signInAs(staffEmail, STAFF_PASSWORD);
}, 30000);

afterAll(async () => {
  const admin = createAdminClient();
  if (cleanupProductIds.length > 0) {
    await admin.from("products").delete().in("id", cleanupProductIds);
  }
  if (staffUserId) {
    await admin.auth.admin.deleteUser(staffUserId);
  }
  if (data) {
    await cleanupTenants(data);
  }
}, 30000);

describe("getProducts", () => {
  it("returns only the caller's club's products, not club B's", async () => {
    const products = await getProducts(clubAClient, data.clubA.clubId);
    const ids = products.map((p) => p.id);
    expect(ids).toContain(data.clubA.productId);
    expect(ids).not.toContain(data.clubB.productId);
  });

  it("returns the fixture product's real stock from product_stock (100, via its seeded PURCHASE move)", async () => {
    const products = await getProducts(clubAClient, data.clubA.clubId);
    const fixtureProduct = products.find((p) => p.id === data.clubA.productId);
    expect(fixtureProduct).toBeDefined();
    expect(fixtureProduct!.stock).toBe(100);
  });

  it("defaults a product with zero inventory moves to stock 0", async () => {
    const created = await createProduct(clubAClient, data.clubA.clubId, {
      name: "No Moves Product",
      category: "Flower",
      unit: "per 1g",
      tokenPrice: 40,
      sellPrice: 50,
      flags: [],
    });
    cleanupProductIds.push(created.id);

    const products = await getProducts(clubAClient, data.clubA.clubId);
    const found = products.find((p) => p.id === created.id);
    expect(found).toBeDefined();
    expect(found!.stock).toBe(0);
  });
});

describe("createProduct", () => {
  it("creates a product scoped to the caller's club, active, with the given fields", async () => {
    const created = await createProduct(clubAClient, data.clubA.clubId, {
      name: "New Flower",
      category: "Flower",
      unit: "per 1g",
      tokenPrice: 45,
      sellPrice: 60,
      cost: 40.5,
      description: "Test description",
      flags: ["app", "gift"],
    });
    cleanupProductIds.push(created.id);

    expect(created.name).toBe("New Flower");
    expect(created.active).toBe(true);
    expect(created.stock).toBe(0);
    expect(created.cost).toBe(40.5);
    expect(created.flags).toEqual(["app", "gift"]);
  });
});

describe("updateProduct", () => {
  it("updates fields without touching stock", async () => {
    const created = await createProduct(clubAClient, data.clubA.clubId, {
      name: "Before Update",
      category: "Edibles",
      unit: "each",
      tokenPrice: 20,
      sellPrice: 30,
      flags: [],
    });
    cleanupProductIds.push(created.id);

    const updated = await updateProduct(clubAClient, data.clubA.clubId, created.id, {
      name: "After Update",
      category: "Edibles",
      unit: "each",
      tokenPrice: 25,
      sellPrice: 35,
      flags: ["nodisc"],
    });

    expect(updated.name).toBe("After Update");
    expect(updated.tokenPrice).toBe(25);
    expect(updated.flags).toEqual(["nodisc"]);
    expect(updated.stock).toBe(0);
  });

  it("does not update a product belonging to a different club", async () => {
    await expect(
      updateProduct(clubBClient, data.clubB.clubId, data.clubA.productId, {
        name: "Hijacked",
        category: "Flower",
        unit: "per 1g",
        tokenPrice: 1,
        sellPrice: 1,
        flags: [],
      }),
    ).rejects.toThrow();
  });
});

describe("hasProductHistory / deleteOrDeactivateProduct", () => {
  it("returns false for a product with no inventory moves, and hard-deletes it", async () => {
    const created = await createProduct(clubAClient, data.clubA.clubId, {
      name: "No History",
      category: "Accessory",
      unit: "each",
      tokenPrice: 5,
      sellPrice: 10,
      flags: [],
    });

    const hasHistory = await hasProductHistory(clubAClient, data.clubA.clubId, created.id);
    expect(hasHistory).toBe(false);

    const result = await deleteOrDeactivateProduct(clubAClient, data.clubA.clubId, created.id);
    expect(result).toEqual({ action: "deleted" });

    const products = await getProducts(clubAClient, data.clubA.clubId);
    expect(products.map((p) => p.id)).not.toContain(created.id);
  });

  it("returns true for the fixture product (has a seeded PURCHASE move), and deactivates instead of deleting", async () => {
    const hasHistory = await hasProductHistory(clubAClient, data.clubA.clubId, data.clubA.productId);
    expect(hasHistory).toBe(true);

    const result = await deleteOrDeactivateProduct(clubAClient, data.clubA.clubId, data.clubA.productId);
    expect(result).toEqual({ action: "deactivated" });

    const products = await getProducts(clubAClient, data.clubA.clubId);
    const fixtureProduct = products.find((p) => p.id === data.clubA.productId);
    expect(fixtureProduct).toBeDefined();
    expect(fixtureProduct!.active).toBe(false);

    // Toggle back so this file's own fixture club is left in its original
    // state, in case any later test in this same file depends on it.
    const reactivateResult = await deleteOrDeactivateProduct(
      clubAClient,
      data.clubA.clubId,
      data.clubA.productId,
    );
    expect(reactivateResult).toEqual({ action: "reactivated" });
  });
});

describe("role-based access", () => {
  it("rejects a staff-role user calling createProduct/updateProduct/deleteOrDeactivateProduct, but admin still succeeds", async () => {
    await expect(
      createProduct(staffClient, data.clubA.clubId, {
        name: "Staff Attempt",
        category: "Flower",
        unit: "per 1g",
        tokenPrice: 10,
        sellPrice: 15,
        flags: [],
      }),
    ).rejects.toThrow("Admin access required");

    const product = await createProduct(clubAClient, data.clubA.clubId, {
      name: "Admin Created Product",
      category: "Flower",
      unit: "per 1g",
      tokenPrice: 10,
      sellPrice: 15,
      flags: [],
    });
    cleanupProductIds.push(product.id);

    await expect(
      updateProduct(staffClient, data.clubA.clubId, product.id, {
        name: "Staff Edited",
        category: "Flower",
        unit: "per 1g",
        tokenPrice: 20,
        sellPrice: 30,
        flags: [],
      }),
    ).rejects.toThrow("Admin access required");

    const updated = await updateProduct(clubAClient, data.clubA.clubId, product.id, {
      name: "Admin Edited",
      category: "Flower",
      unit: "per 1g",
      tokenPrice: 20,
      sellPrice: 30,
      flags: [],
    });
    expect(updated.name).toBe("Admin Edited");

    await expect(deleteOrDeactivateProduct(staffClient, data.clubA.clubId, product.id)).rejects.toThrow(
      "Admin access required",
    );

    const result = await deleteOrDeactivateProduct(clubAClient, data.clubA.clubId, product.id);
    expect(result.action).toBe("deleted");
  });

  it("RLS itself rejects a direct staff INSERT/UPDATE/DELETE on products, bypassing assertClubAdmin entirely", async () => {
    const { error: insertError } = await staffClient.from("products").insert({
      club_id: data.clubA.clubId,
      name: "Direct REST Bypass Attempt",
      category: "Flower",
      unit: "per 1g",
      token_price: 10,
      sell_price: 15,
    });
    expect(insertError).not.toBeNull();

    const { data: adminProduct, error: adminInsertError } = await clubAClient
      .from("products")
      .insert({
        club_id: data.clubA.clubId,
        name: "Direct Admin Insert",
        category: "Flower",
        unit: "per 1g",
        token_price: 10,
        sell_price: 15,
      })
      .select()
      .single();
    expect(adminInsertError).toBeNull();
    cleanupProductIds.push(adminProduct!.id);

    const { error: staffUpdateError } = await staffClient
      .from("products")
      .update({ name: "Staff Direct Update Attempt" })
      .eq("id", adminProduct!.id);
    // RLS silently matches zero rows rather than throwing — assert the
    // name was NOT changed, not just that no error was thrown.
    const { data: afterStaffUpdate } = await clubAClient
      .from("products")
      .select("name")
      .eq("id", adminProduct!.id)
      .single();
    expect(afterStaffUpdate!.name).toBe("Direct Admin Insert");
    void staffUpdateError;

    const { error: staffDeleteError } = await staffClient.from("products").delete().eq("id", adminProduct!.id);
    void staffDeleteError;
    const { data: stillExists } = await clubAClient
      .from("products")
      .select("id")
      .eq("id", adminProduct!.id)
      .maybeSingle();
    expect(stillExists).not.toBeNull();
  });
});
