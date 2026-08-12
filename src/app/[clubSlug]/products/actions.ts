"use server";

import { createClient } from "@/lib/supabase/server";
import {
  createProduct,
  updateProduct,
  hasProductHistory,
  deleteOrDeactivateProduct,
  type Product,
  type ProductInput,
  type DeleteOrDeactivateResult,
} from "@/lib/products";
import { createCategory, renameCategory, deleteCategory, type ProductCategoryRow } from "@/lib/categories";

export async function createProductAction(
  clubId: string,
  input: ProductInput,
): Promise<{ ok: true; product: Product } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const product = await createProduct(supabase, clubId, input);
    return { ok: true, product };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to create product" };
  }
}

export async function updateProductAction(
  clubId: string,
  productId: string,
  input: ProductInput,
): Promise<{ ok: true; product: Product } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const product = await updateProduct(supabase, clubId, productId, input);
    return { ok: true, product };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to save product" };
  }
}

export async function checkProductHistoryAction(
  clubId: string,
  productId: string,
): Promise<{ ok: true; hasHistory: boolean } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const hasHistory = await hasProductHistory(supabase, clubId, productId);
    return { ok: true, hasHistory };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to check product history" };
  }
}

export async function deleteOrDeactivateProductAction(
  clubId: string,
  productId: string,
): Promise<{ ok: true; result: DeleteOrDeactivateResult } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const result = await deleteOrDeactivateProduct(supabase, clubId, productId);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to delete or deactivate product" };
  }
}

export async function createCategoryAction(
  clubId: string,
  name: string,
): Promise<{ ok: true; category: ProductCategoryRow } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const category = await createCategory(supabase, clubId, name);
    return { ok: true, category };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to add category" };
  }
}

export async function renameCategoryAction(
  clubId: string,
  categoryId: string,
  name: string,
): Promise<{ ok: true; category: ProductCategoryRow } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const category = await renameCategory(supabase, clubId, categoryId, name);
    return { ok: true, category };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to rename category" };
  }
}

export async function deleteCategoryAction(
  clubId: string,
  categoryId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    await deleteCategory(supabase, clubId, categoryId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to delete category" };
  }
}
