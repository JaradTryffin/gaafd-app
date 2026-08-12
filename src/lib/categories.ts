import type { SupabaseClient } from "@supabase/supabase-js";
import { assertClubAdmin } from "@/lib/auth/require-role";

export type ProductCategoryRow = { id: string; name: string };

export async function getCategories(supabase: SupabaseClient, clubId: string): Promise<ProductCategoryRow[]> {
  const { data, error } = await supabase
    .from("product_categories")
    .select("id, name")
    .eq("club_id", clubId)
    .order("name", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => ({ id: row.id as string, name: row.name as string }));
}

export async function createCategory(
  supabase: SupabaseClient,
  clubId: string,
  name: string,
): Promise<ProductCategoryRow> {
  await assertClubAdmin(supabase, clubId);
  const { data, error } = await supabase
    .from("product_categories")
    .insert({ club_id: clubId, name })
    .select("id, name")
    .single();
  if (error) throw error;
  return { id: data.id as string, name: data.name as string };
}

export async function renameCategory(
  supabase: SupabaseClient,
  clubId: string,
  categoryId: string,
  name: string,
): Promise<ProductCategoryRow> {
  await assertClubAdmin(supabase, clubId);
  const { data, error } = await supabase
    .from("product_categories")
    .update({ name })
    .eq("id", categoryId)
    .eq("club_id", clubId)
    .select("id, name")
    .single();
  if (error) throw error;
  return { id: data.id as string, name: data.name as string };
}

export async function deleteCategory(supabase: SupabaseClient, clubId: string, categoryId: string): Promise<void> {
  await assertClubAdmin(supabase, clubId);

  const { count, error: countError } = await supabase
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("club_id", clubId)
    .eq("category_id", categoryId);
  if (countError) throw countError;
  if ((count ?? 0) > 0) {
    throw new Error(`Cannot delete: ${count} product(s) still use this category`);
  }

  const { error } = await supabase.from("product_categories").delete().eq("id", categoryId).eq("club_id", clubId);
  if (error) throw error;
}
