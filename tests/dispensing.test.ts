import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedTenants, cleanupTenants, signInAs, type SeededData } from "./rls/fixtures";
import { createAdminClient } from "@/lib/supabase/admin";
import { createDispenseOrder } from "@/lib/dispensing";

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

async function seedProduct(clubId: string, tokenPrice: number, stock: number) {
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
      name: `Dispense Test Product ${crypto.randomUUID().slice(0, 8)}`,
      category_id: category.id,
      unit: "per 1g",
      token_price: tokenPrice,
      sell_price: tokenPrice * 1.5,
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
      code: `DISP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      first: "Dispense",
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

async function getStock(productId: string): Promise<number> {
  const admin = createAdminClient();
  const { data: row } = await admin
    .from("product_stock")
    .select("stock")
    .eq("product_id", productId)
    .maybeSingle();
  return row?.stock ?? 0;
}

async function getBalance(memberId: string): Promise<number> {
  const admin = createAdminClient();
  const { data: row } = await admin
    .from("members")
    .select("token_balance")
    .eq("id", memberId)
    .single();
  return row!.token_balance;
}

describe("createDispenseOrder", () => {
  it("completes a multi-line order: decrements stock per line, debits the token total, snapshots items", async () => {
    const productA = await seedProduct(data.clubA.clubId, 40, 50);
    const productB = await seedProduct(data.clubA.clubId, 20, 30);
    const member = await seedMemberWithBalance(data.clubA.clubId, 200);

    const order = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: productA.id, qty: 2 },
      { productId: productB.id, qty: 3 },
    ]);
    cleanupOrderIds.push(order.id);

    expect(order.tokenTotal).toBe(2 * 40 + 3 * 20);
    expect(order.items).toHaveLength(2);
    expect(order.items.find((i) => i.productId === productA.id)?.lineTotal).toBe(80);
    expect(order.items.find((i) => i.productId === productB.id)?.lineTotal).toBe(60);

    expect(await getStock(productA.id)).toBe(48);
    expect(await getStock(productB.id)).toBe(27);
    expect(await getBalance(member.id)).toBe(200 - 140);
  });

  it("rejects an order when requested qty exceeds current stock", async () => {
    const product = await seedProduct(data.clubA.clubId, 40, 5);
    const member = await seedMemberWithBalance(data.clubA.clubId, 1000);

    await expect(
      createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [{ productId: product.id, qty: 10 }]),
    ).rejects.toThrow();

    expect(await getStock(product.id)).toBe(5);
    expect(await getBalance(member.id)).toBe(1000);
  });

  it("rejects an order when the member's token balance is insufficient", async () => {
    const product = await seedProduct(data.clubA.clubId, 100, 50);
    const member = await seedMemberWithBalance(data.clubA.clubId, 50);

    await expect(
      createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [{ productId: product.id, qty: 1 }]),
    ).rejects.toThrow();

    expect(await getStock(product.id)).toBe(50);
    expect(await getBalance(member.id)).toBe(50);
  });

  it("rejects when duplicate-product lines jointly exceed stock", async () => {
    const product = await seedProduct(data.clubA.clubId, 40, 20);
    const member = await seedMemberWithBalance(data.clubA.clubId, 1000);

    await expect(
      createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
        { productId: product.id, qty: 15 },
        { productId: product.id, qty: 15 },
      ]),
    ).rejects.toThrow();

    expect(await getStock(product.id)).toBe(20);
    expect(await getBalance(member.id)).toBe(1000);
  });

  it("merges duplicate-product lines into one snapshot line and one inventory_moves row on success", async () => {
    const product = await seedProduct(data.clubA.clubId, 40, 20);
    const member = await seedMemberWithBalance(data.clubA.clubId, 1000);

    const order = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: product.id, qty: 8 },
      { productId: product.id, qty: 7 },
    ]);
    cleanupOrderIds.push(order.id);

    expect(order.items).toHaveLength(1);
    expect(order.items[0].qty).toBe(15);
    expect(order.items[0].lineTotal).toBe(15 * 40);

    expect(await getStock(product.id)).toBe(20 - 15);
    expect(await getBalance(member.id)).toBe(1000 - 15 * 40);

    const admin = createAdminClient();
    const { data: moves, error } = await admin
      .from("inventory_moves")
      .select("id")
      .eq("order_id", order.id);
    if (error) throw error;
    expect(moves).toHaveLength(1);
  });

  it("rejects a product belonging to a different club", async () => {
    const member = await seedMemberWithBalance(data.clubA.clubId, 1000);

    await expect(
      createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
        { productId: data.clubB.productId, qty: 1 },
      ]),
    ).rejects.toThrow();
  });

  it("rejects a member belonging to a different club", async () => {
    const product = await seedProduct(data.clubA.clubId, 40, 50);

    await expect(
      createDispenseOrder(clubAClient, data.clubA.clubId, data.clubB.memberId, [
        { productId: product.id, qty: 1 },
      ]),
    ).rejects.toThrow("Member not found in this club");
  });

  it("rolls back the entire order when any single line is invalid, leaving earlier lines' stock untouched", async () => {
    const productA = await seedProduct(data.clubA.clubId, 40, 50);
    const productB = await seedProduct(data.clubA.clubId, 20, 2);
    const member = await seedMemberWithBalance(data.clubA.clubId, 1000);

    await expect(
      createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
        { productId: productA.id, qty: 5 },
        { productId: productB.id, qty: 10 },
      ]),
    ).rejects.toThrow();

    expect(await getStock(productA.id)).toBe(50);
    expect(await getStock(productB.id)).toBe(2);
    expect(await getBalance(member.id)).toBe(1000);
  });
});

describe("bulk pricing", () => {
  it("checks out at the flat price when no tiers are configured (regression)", async () => {
    const product = await seedProduct(data.clubA.clubId, 150, 50);
    const member = await seedMemberWithBalance(data.clubA.clubId, 5000);

    const order = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: product.id, qty: 3 },
    ]);
    cleanupOrderIds.push(order.id);

    expect(order.tokenTotal).toBe(450);
    expect(order.items[0].tokenPrice).toBe(150);
  });

  it("applies the base price below a tier threshold and the tier price at/above it", async () => {
    const product = await seedProduct(data.clubA.clubId, 150, 50);
    const member = await seedMemberWithBalance(data.clubA.clubId, 5000);
    const admin = createAdminClient();
    const { error } = await admin
      .from("products")
      .update({ price_tiers: [{ minQty: 10, unitPrice: 100 }] })
      .eq("id", product.id);
    if (error) throw error;

    const belowThreshold = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: product.id, qty: 5 },
    ]);
    cleanupOrderIds.push(belowThreshold.id);
    expect(belowThreshold.tokenTotal).toBe(750);
    expect(belowThreshold.items[0].tokenPrice).toBe(150);

    const atThreshold = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: product.id, qty: 10 },
    ]);
    cleanupOrderIds.push(atThreshold.id);
    expect(atThreshold.tokenTotal).toBe(1000);
    expect(atThreshold.items[0].tokenPrice).toBe(100);
  });

  it("prices a two-line order of the same product at the tier rate when the combined quantity crosses the threshold", async () => {
    const product = await seedProduct(data.clubA.clubId, 150, 50);
    const member = await seedMemberWithBalance(data.clubA.clubId, 5000);
    const admin = createAdminClient();
    const { error } = await admin
      .from("products")
      .update({ price_tiers: [{ minQty: 10, unitPrice: 100 }] })
      .eq("id", product.id);
    if (error) throw error;

    // Neither line alone reaches qty 10, but combined (4+6=10) they do —
    // proves the tier lookup happens after aggregation, not per raw line.
    const order = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: product.id, qty: 4 },
      { productId: product.id, qty: 6 },
    ]);
    cleanupOrderIds.push(order.id);

    expect(order.tokenTotal).toBe(1000);
    expect(order.items).toHaveLength(1);
    expect(order.items[0].qty).toBe(10);
    expect(order.items[0].tokenPrice).toBe(100);
  });
});

describe("gifting", () => {
  it("checks out a gift-only order at tokenTotal 0, decrements stock, leaves balance unchanged", async () => {
    const product = await seedProduct(data.clubA.clubId, 150, 50);
    const member = await seedMemberWithBalance(data.clubA.clubId, 1000);

    const order = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: product.id, qty: 1, isGift: true, giftReason: "Loyalty" },
    ]);
    cleanupOrderIds.push(order.id);

    expect(order.tokenTotal).toBe(0);
    expect(order.items).toHaveLength(1);
    expect(order.items[0].isGift).toBe(true);
    expect(order.items[0].giftReason).toBe("Loyalty");
    expect(order.items[0].tokenPrice).toBe(150);
    expect(order.items[0].lineTotal).toBe(150);

    expect(await getStock(product.id)).toBe(49);
    expect(await getBalance(member.id)).toBe(1000);
  });

  it("charges only the paid line in a mixed paid+gift order, both lines decrement stock", async () => {
    const paidProduct = await seedProduct(data.clubA.clubId, 40, 50);
    const giftProduct = await seedProduct(data.clubA.clubId, 60, 30);
    const member = await seedMemberWithBalance(data.clubA.clubId, 1000);

    const order = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: paidProduct.id, qty: 2 },
      { productId: giftProduct.id, qty: 1, isGift: true, giftReason: null },
    ]);
    cleanupOrderIds.push(order.id);

    expect(order.tokenTotal).toBe(80);
    const paidItem = order.items.find((i) => i.productId === paidProduct.id);
    const giftItem = order.items.find((i) => i.productId === giftProduct.id);
    expect(paidItem?.isGift).toBe(false);
    expect(paidItem?.lineTotal).toBe(80);
    expect(giftItem?.isGift).toBe(true);
    expect(giftItem?.lineTotal).toBe(60);

    expect(await getStock(paidProduct.id)).toBe(48);
    expect(await getStock(giftProduct.id)).toBe(29);
    expect(await getBalance(member.id)).toBe(1000 - 80);
  });

  it("succeeds for an all-gift order even at zero balance", async () => {
    const product = await seedProduct(data.clubA.clubId, 200, 10);
    const member = await seedMemberWithBalance(data.clubA.clubId, 0);

    const order = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: product.id, qty: 1, isGift: true },
    ]);
    cleanupOrderIds.push(order.id);

    expect(order.tokenTotal).toBe(0);
    expect(await getStock(product.id)).toBe(9);
    expect(await getBalance(member.id)).toBe(0);
  });

  it("a normal order with no gift lines has isGift:false on every item (regression)", async () => {
    const product = await seedProduct(data.clubA.clubId, 40, 50);
    const member = await seedMemberWithBalance(data.clubA.clubId, 1000);

    const order = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: product.id, qty: 3 },
    ]);
    cleanupOrderIds.push(order.id);

    expect(order.items[0].isGift).toBe(false);
    expect(order.items[0].giftReason).toBeNull();
  });
});
