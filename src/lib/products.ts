import type { SupabaseClient } from "@supabase/supabase-js";
import { assertClubAdmin } from "@/lib/auth/require-role";

export type PriceTier = { minQty: number; unitPrice: number };

export type Product = {
  id: string;
  name: string;
  categoryId: string;
  categoryName: string;
  unit: string;
  tokenPrice: number;
  sellPrice: number;
  cost: number | null;
  description: string | null;
  flags: string[];
  active: boolean;
  stock: number;
  priceTiers: PriceTier[];
};

type ProductRow = {
  id: string;
  name: string;
  category_id: string;
  unit: string;
  token_price: number;
  sell_price: number;
  cost: number | null;
  description: string | null;
  flags: string[];
  price_tiers: PriceTier[];
  active: boolean;
};

function mapProduct(row: ProductRow, stock: number, categoryName: string): Product {
  return {
    id: row.id,
    name: row.name,
    categoryId: row.category_id,
    categoryName,
    unit: row.unit,
    tokenPrice: row.token_price,
    sellPrice: Number(row.sell_price),
    cost: row.cost === null ? null : Number(row.cost),
    description: row.description,
    flags: row.flags ?? [],
    priceTiers: row.price_tiers ?? [],
    active: row.active,
    stock,
  };
}

const PRODUCT_COLUMNS = "id, name, category_id, unit, token_price, sell_price, cost, description, flags, price_tiers, active";

export async function getProducts(supabase: SupabaseClient, clubId: string): Promise<Product[]> {
  const { data: products, error: productsError } = await supabase
    .from("products")
    .select(PRODUCT_COLUMNS)
    .eq("club_id", clubId)
    .order("name", { ascending: true });
  if (productsError) throw productsError;

  const rows = products ?? [];
  if (rows.length === 0) return [];

  const { data: stockRows, error: stockError } = await supabase
    .from("product_stock")
    .select("product_id, stock")
    .eq("club_id", clubId)
    .in(
      "product_id",
      rows.map((p) => p.id),
    );
  if (stockError) throw stockError;

  const stockByProductId = new Map(
    (stockRows ?? []).map((r) => [r.product_id as string, r.stock as number]),
  );

  const categoryIds = [...new Set(rows.map((r) => r.category_id as string))];
  const { data: categories, error: categoriesError } = await supabase
    .from("product_categories")
    .select("id, name")
    .in("id", categoryIds);
  if (categoriesError) throw categoriesError;
  const categoryNameById = new Map((categories ?? []).map((c) => [c.id as string, c.name as string]));

  return rows.map((row) =>
    mapProduct(
      row as ProductRow,
      stockByProductId.get(row.id as string) ?? 0,
      categoryNameById.get(row.category_id as string) ?? "—",
    ),
  );
}

export type ProductInput = {
  name: string;
  categoryId: string;
  unit: string;
  tokenPrice: number;
  sellPrice: number;
  cost?: number | null;
  description?: string | null;
  flags: string[];
  priceTiers: PriceTier[];
};

export async function createProduct(
  supabase: SupabaseClient,
  clubId: string,
  input: ProductInput,
): Promise<Product> {
  await assertClubAdmin(supabase, clubId);
  const { data, error } = await supabase
    .from("products")
    .insert({
      club_id: clubId,
      name: input.name,
      category_id: input.categoryId,
      unit: input.unit,
      token_price: input.tokenPrice,
      sell_price: input.sellPrice,
      cost: input.cost ?? null,
      description: input.description || null,
      flags: input.flags,
      price_tiers: input.priceTiers,
    })
    .select(PRODUCT_COLUMNS)
    .single();
  if (error) throw error;

  const { data: category, error: categoryError } = await supabase
    .from("product_categories")
    .select("name")
    .eq("id", input.categoryId)
    .single();
  if (categoryError) throw categoryError;

  return mapProduct(data as ProductRow, 0, category.name as string);
}

export async function updateProduct(
  supabase: SupabaseClient,
  clubId: string,
  productId: string,
  input: ProductInput,
): Promise<Product> {
  await assertClubAdmin(supabase, clubId);
  const { data, error } = await supabase
    .from("products")
    .update({
      name: input.name,
      category_id: input.categoryId,
      unit: input.unit,
      token_price: input.tokenPrice,
      sell_price: input.sellPrice,
      cost: input.cost ?? null,
      description: input.description || null,
      flags: input.flags,
      price_tiers: input.priceTiers,
    })
    .eq("id", productId)
    .eq("club_id", clubId)
    .select(PRODUCT_COLUMNS)
    .single();
  if (error) throw error;

  const { data: stockRow } = await supabase
    .from("product_stock")
    .select("stock")
    .eq("product_id", productId)
    .eq("club_id", clubId)
    .maybeSingle();

  const { data: category, error: categoryError } = await supabase
    .from("product_categories")
    .select("name")
    .eq("id", input.categoryId)
    .single();
  if (categoryError) throw categoryError;

  return mapProduct(data as ProductRow, stockRow?.stock ?? 0, category.name as string);
}

export async function hasProductHistory(
  supabase: SupabaseClient,
  clubId: string,
  productId: string,
): Promise<boolean> {
  const { count, error } = await supabase
    .from("inventory_moves")
    .select("id", { count: "exact", head: true })
    .eq("club_id", clubId)
    .eq("product_id", productId);
  if (error) throw error;
  return (count ?? 0) > 0;
}

export type DeleteOrDeactivateResult =
  | { action: "deleted" }
  | { action: "deactivated" }
  | { action: "reactivated" };

export async function deleteOrDeactivateProduct(
  supabase: SupabaseClient,
  clubId: string,
  productId: string,
): Promise<DeleteOrDeactivateResult> {
  await assertClubAdmin(supabase, clubId);
  const hasHistory = await hasProductHistory(supabase, clubId, productId);

  if (!hasHistory) {
    const { error } = await supabase.from("products").delete().eq("id", productId).eq("club_id", clubId);
    if (error) throw error;
    return { action: "deleted" };
  }

  const { data: current, error: fetchError } = await supabase
    .from("products")
    .select("active")
    .eq("id", productId)
    .eq("club_id", clubId)
    .single();
  if (fetchError) throw fetchError;

  const nextActive = !current.active;
  const { error: updateError } = await supabase
    .from("products")
    .update({ active: nextActive })
    .eq("id", productId)
    .eq("club_id", clubId);
  if (updateError) throw updateError;

  return { action: nextActive ? "reactivated" : "deactivated" };
}

export function effectiveUnitPrice(basePrice: number, tiers: PriceTier[], qty: number): number {
  const applicable = tiers.filter((t) => t.minQty <= qty).sort((a, b) => b.minQty - a.minQty);
  return applicable.length > 0 ? applicable[0].unitPrice : basePrice;
}
