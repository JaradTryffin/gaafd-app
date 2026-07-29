import type { SupabaseClient } from "@supabase/supabase-js";

export type ProductCategory = "Flower" | "Pre-rolls" | "Edibles" | "Concentrate" | "Accessory";

export type Product = {
  id: string;
  name: string;
  category: ProductCategory;
  unit: string;
  tokenPrice: number;
  sellPrice: number;
  cost: number | null;
  description: string | null;
  flags: string[];
  active: boolean;
  stock: number;
};

type ProductRow = {
  id: string;
  name: string;
  category: string;
  unit: string;
  token_price: number;
  sell_price: number;
  cost: number | null;
  description: string | null;
  flags: string[];
  active: boolean;
};

function mapProduct(row: ProductRow, stock: number): Product {
  return {
    id: row.id,
    name: row.name,
    category: row.category as ProductCategory,
    unit: row.unit,
    tokenPrice: row.token_price,
    sellPrice: Number(row.sell_price),
    cost: row.cost === null ? null : Number(row.cost),
    description: row.description,
    flags: row.flags ?? [],
    active: row.active,
    stock,
  };
}

const PRODUCT_COLUMNS = "id, name, category, unit, token_price, sell_price, cost, description, flags, active";

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

  return rows.map((row) => mapProduct(row as ProductRow, stockByProductId.get(row.id as string) ?? 0));
}

export type ProductInput = {
  name: string;
  category: ProductCategory;
  unit: string;
  tokenPrice: number;
  sellPrice: number;
  cost?: number | null;
  description?: string | null;
  flags: string[];
};

export async function createProduct(
  supabase: SupabaseClient,
  clubId: string,
  input: ProductInput,
): Promise<Product> {
  const { data, error } = await supabase
    .from("products")
    .insert({
      club_id: clubId,
      name: input.name,
      category: input.category,
      unit: input.unit,
      token_price: input.tokenPrice,
      sell_price: input.sellPrice,
      cost: input.cost ?? null,
      description: input.description || null,
      flags: input.flags,
    })
    .select(PRODUCT_COLUMNS)
    .single();
  if (error) throw error;
  return mapProduct(data as ProductRow, 0);
}

export async function updateProduct(
  supabase: SupabaseClient,
  clubId: string,
  productId: string,
  input: ProductInput,
): Promise<Product> {
  const { data, error } = await supabase
    .from("products")
    .update({
      name: input.name,
      category: input.category,
      unit: input.unit,
      token_price: input.tokenPrice,
      sell_price: input.sellPrice,
      cost: input.cost ?? null,
      description: input.description || null,
      flags: input.flags,
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
  return mapProduct(data as ProductRow, stockRow?.stock ?? 0);
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
