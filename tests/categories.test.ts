import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedTenants, cleanupTenants, signInAs, type SeededData } from "./rls/fixtures";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCategories, createCategory, renameCategory, deleteCategory } from "@/lib/categories";
import { getProducts, createProduct } from "@/lib/products";

let data: SeededData;
let clubAClient: SupabaseClient;
let clubBClient: SupabaseClient;
let staffClient: SupabaseClient;
let staffUserId: string;
const STAFF_PASSWORD = "Test-Password-123!";
const cleanupCategoryIds: string[] = [];
const cleanupProductIds: string[] = [];

beforeAll(async () => {
  data = await seedTenants();
  clubAClient = await signInAs(data.clubA.adminEmail, data.clubA.adminPassword);
  clubBClient = await signInAs(data.clubB.adminEmail, data.clubB.adminPassword);

  const admin = createAdminClient();
  const staffEmail = `categories-staff-${crypto.randomUUID().slice(0, 8)}@example.test`;
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
  if (cleanupCategoryIds.length > 0) {
    await admin.from("product_categories").delete().in("id", cleanupCategoryIds);
  }
  if (staffUserId) {
    await admin.auth.admin.deleteUser(staffUserId);
  }
  if (data) {
    await cleanupTenants(data);
  }
}, 30000);

describe("getCategories", () => {
  it("returns only the caller's club's categories, not club B's", async () => {
    const categories = await getCategories(clubAClient, data.clubA.clubId);
    const ids = categories.map((c) => c.id);
    expect(ids).toContain(data.clubA.categoryId);

    const clubBCategories = await getCategories(clubBClient, data.clubB.clubId);
    expect(clubBCategories.map((c) => c.id)).not.toContain(data.clubA.categoryId);
  });
});

describe("createCategory", () => {
  it("rejects a staff-role user, admin succeeds", async () => {
    await expect(createCategory(staffClient, data.clubA.clubId, "Staff Attempt")).rejects.toThrow(
      "Admin access required",
    );

    const category = await createCategory(clubAClient, data.clubA.clubId, "Merch");
    cleanupCategoryIds.push(category.id);
    expect(category.name).toBe("Merch");
  });

  it("RLS itself rejects a direct staff INSERT on product_categories, bypassing assertClubAdmin entirely", async () => {
    const { error: staffInsertError } = await staffClient.from("product_categories").insert({
      club_id: data.clubA.clubId,
      name: "Direct REST Bypass Attempt",
    });
    expect(staffInsertError).not.toBeNull();

    const { data: adminCategory, error: adminInsertError } = await clubAClient
      .from("product_categories")
      .insert({ club_id: data.clubA.clubId, name: "Direct Admin Insert" })
      .select()
      .single();
    expect(adminInsertError).toBeNull();
    cleanupCategoryIds.push(adminCategory!.id);

    const { error: staffUpdateError } = await staffClient
      .from("product_categories")
      .update({ name: "Staff Direct Update Attempt" })
      .eq("id", adminCategory!.id);
    void staffUpdateError;
    const { data: afterStaffUpdate } = await clubAClient
      .from("product_categories")
      .select("name")
      .eq("id", adminCategory!.id)
      .single();
    expect(afterStaffUpdate!.name).toBe("Direct Admin Insert");

    const { error: staffDeleteError } = await staffClient
      .from("product_categories")
      .delete()
      .eq("id", adminCategory!.id);
    void staffDeleteError;
    const { data: stillExists } = await clubAClient
      .from("product_categories")
      .select("id")
      .eq("id", adminCategory!.id)
      .maybeSingle();
    expect(stillExists).not.toBeNull();
  });
});

describe("renameCategory", () => {
  it("updates the name, and getProducts reflects it immediately for any product referencing it", async () => {
    const category = await createCategory(clubAClient, data.clubA.clubId, "Original Name");
    cleanupCategoryIds.push(category.id);

    const product = await createProduct(clubAClient, data.clubA.clubId, {
      name: "Renamed Category Product",
      categoryId: category.id,
      unit: "per 1g",
      tokenPrice: 10,
      sellPrice: 15,
      flags: [],
      priceTiers: [],
    });
    cleanupProductIds.push(product.id);

    await renameCategory(clubAClient, data.clubA.clubId, category.id, "Renamed");

    const products = await getProducts(clubAClient, data.clubA.clubId);
    const found = products.find((p) => p.id === product.id);
    expect(found).toBeDefined();
    expect(found!.categoryName).toBe("Renamed");
  });
});

describe("deleteCategory", () => {
  it("succeeds when unused, rejects when a product references it, and rejects staff", async () => {
    const unused = await createCategory(clubAClient, data.clubA.clubId, "Unused Category");
    await deleteCategory(clubAClient, data.clubA.clubId, unused.id);
    const remaining = await getCategories(clubAClient, data.clubA.clubId);
    expect(remaining.map((c) => c.id)).not.toContain(unused.id);

    const inUse = await createCategory(clubAClient, data.clubA.clubId, "In Use Category");
    cleanupCategoryIds.push(inUse.id);
    const product = await createProduct(clubAClient, data.clubA.clubId, {
      name: "Blocks Category Delete",
      categoryId: inUse.id,
      unit: "per 1g",
      tokenPrice: 10,
      sellPrice: 15,
      flags: [],
      priceTiers: [],
    });
    cleanupProductIds.push(product.id);

    await expect(deleteCategory(clubAClient, data.clubA.clubId, inUse.id)).rejects.toThrow(
      "1 product(s) still use this category",
    );

    await expect(deleteCategory(staffClient, data.clubA.clubId, inUse.id)).rejects.toThrow(
      "Admin access required",
    );
  });
});
