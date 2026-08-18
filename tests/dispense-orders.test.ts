import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedTenants, cleanupTenants, signInAs, type SeededData } from "./rls/fixtures";
import { createAdminClient } from "@/lib/supabase/admin";
import { createDispenseOrder } from "@/lib/dispensing";
import { getDispenseOrders } from "@/lib/dispense-orders";

let data: SeededData;
let clubAClient: SupabaseClient;
let clubBClient: SupabaseClient;
const cleanupOrderIds: string[] = [];
const cleanupMoveIds: string[] = [];
const cleanupProductIds: string[] = [];
const cleanupMemberIds: string[] = [];

beforeAll(async () => {
  data = await seedTenants();
  clubAClient = await signInAs(data.clubA.adminEmail, data.clubA.adminPassword);
  clubBClient = await signInAs(data.clubB.adminEmail, data.clubB.adminPassword);
}, 30000);

afterAll(async () => {
  const admin = createAdminClient();
  if (cleanupOrderIds.length > 0) {
    await admin.from("dispense_orders").delete().in("id", cleanupOrderIds);
  }
  if (cleanupMoveIds.length > 0) {
    await admin.from("inventory_moves").delete().in("id", cleanupMoveIds);
  }
  if (cleanupProductIds.length > 0) {
    await admin.from("products").delete().in("id", cleanupProductIds);
  }
  if (cleanupMemberIds.length > 0) {
    await admin.from("members").delete().in("id", cleanupMemberIds);
  }
  if (data) {
    await cleanupTenants(data);
  }
}, 30000);

async function seedProduct(clubId: string, tokenPrice: number, stock: number, flags: string[] = []) {
  const admin = createAdminClient();
  const { data: category, error: categoryError } = await admin
    .from("product_categories")
    .select("id")
    .eq("club_id", clubId)
    .limit(1)
    .single();
  if (categoryError) throw categoryError;

  const { data: product, error } = await admin
    .from("products")
    .insert({
      club_id: clubId,
      name: `Order History Test Product ${crypto.randomUUID().slice(0, 8)}`,
      category_id: category.id,
      unit: "per 1g",
      token_price: tokenPrice,
      sell_price: tokenPrice * 1.5,
      flags,
    })
    .select()
    .single();
  if (error) throw error;
  cleanupProductIds.push(product.id);

  const { data: move, error: moveError } = await admin
    .from("inventory_moves")
    .insert({ club_id: clubId, product_id: product.id, type: "PURCHASE", qty: stock })
    .select()
    .single();
  if (moveError) throw moveError;
  cleanupMoveIds.push(move.id);

  return product;
}

async function seedMemberWithBalance(clubId: string, tokenBalance: number) {
  const admin = createAdminClient();
  const { data: member, error } = await admin
    .from("members")
    .insert({
      club_id: clubId,
      code: `HIST-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      first: "History",
      last: "Test",
      type: "Full member",
      status: "active",
      token_balance: tokenBalance,
    })
    .select()
    .single();
  if (error) throw error;
  cleanupMemberIds.push(member.id);
  return member;
}

describe("getDispenseOrders", () => {
  it("returns club A's orders newest-first with member names resolved, isolated from club B", async () => {
    const productA = await seedProduct(data.clubA.clubId, 40, 50);
    const memberA = await seedMemberWithBalance(data.clubA.clubId, 1000);
    const productB = await seedProduct(data.clubB.clubId, 40, 50);
    const memberB = await seedMemberWithBalance(data.clubB.clubId, 1000);

    const first = await createDispenseOrder(clubAClient, data.clubA.clubId, memberA.id, [
      { productId: productA.id, qty: 1 },
    ]);
    cleanupOrderIds.push(first.id);
    const second = await createDispenseOrder(clubAClient, data.clubA.clubId, memberA.id, [
      { productId: productA.id, qty: 1 },
    ]);
    cleanupOrderIds.push(second.id);
    const otherClubOrder = await createDispenseOrder(clubBClient, data.clubB.clubId, memberB.id, [
      { productId: productB.id, qty: 1 },
    ]);
    cleanupOrderIds.push(otherClubOrder.id);

    const orders = await getDispenseOrders(clubAClient, data.clubA.clubId);
    const ids = orders.map((o) => o.id);
    expect(ids).not.toContain(otherClubOrder.id);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));

    const found = orders.find((o) => o.id === second.id);
    expect(found?.memberName).toBe("History Test");
  });

  it("giftsOnly filters to only orders containing at least one gift line", async () => {
    const giftableProduct = await seedProduct(data.clubA.clubId, 40, 50, ["gift"]);
    const plainProduct = await seedProduct(data.clubA.clubId, 40, 50);
    const member = await seedMemberWithBalance(data.clubA.clubId, 1000);

    const giftOrder = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: giftableProduct.id, qty: 1, isGift: true },
    ]);
    cleanupOrderIds.push(giftOrder.id);
    const plainOrder = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: plainProduct.id, qty: 1 },
    ]);
    cleanupOrderIds.push(plainOrder.id);

    const giftsOnly = await getDispenseOrders(clubAClient, data.clubA.clubId, { giftsOnly: true });
    const giftsOnlyIds = giftsOnly.map((o) => o.id);
    expect(giftsOnlyIds).toContain(giftOrder.id);
    expect(giftsOnlyIds).not.toContain(plainOrder.id);
  });
});
