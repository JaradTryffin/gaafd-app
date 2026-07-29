import type { SupabaseClient } from "@supabase/supabase-js";

export type MovementType = "PURCHASE" | "SALE" | "ADJUSTMENT" | "WASTE";
export type LoggableMovementType = "PURCHASE" | "ADJUSTMENT" | "WASTE";

export type Movement = {
  id: string;
  type: MovementType;
  productId: string;
  productName: string;
  qty: number;
  cost: number | null;
  batch: string | null;
  expiry: string | null;
  staffEmail: string | null;
  createdAt: string;
};

type MovementRow = {
  id: string;
  type: MovementType;
  product_id: string;
  qty: number;
  cost: number | null;
  batch: string | null;
  expiry: string | null;
  staff_email: string | null;
  created_at: string;
};

const MOVEMENT_COLUMNS = "id, type, product_id, qty, cost, batch, expiry, staff_email, created_at";

export async function getMovements(
  supabase: SupabaseClient,
  clubId: string,
  filters?: { productId?: string; type?: MovementType },
): Promise<Movement[]> {
  let query = supabase
    .from("inventory_moves")
    .select(MOVEMENT_COLUMNS)
    .eq("club_id", clubId)
    .order("created_at", { ascending: false });
  if (filters?.productId) query = query.eq("product_id", filters.productId);
  if (filters?.type) query = query.eq("type", filters.type);

  const { data: moves, error: movesError } = await query;
  if (movesError) throw movesError;

  const rows = moves ?? [];
  if (rows.length === 0) return [];

  const { data: products, error: productsError } = await supabase
    .from("products")
    .select("id, name")
    .eq("club_id", clubId);
  if (productsError) throw productsError;

  const nameByProductId = new Map((products ?? []).map((p) => [p.id as string, p.name as string]));

  return rows.map((row) => {
    const m = row as MovementRow;
    return {
      id: m.id,
      type: m.type,
      productId: m.product_id,
      productName: nameByProductId.get(m.product_id) ?? "—",
      qty: Number(m.qty),
      cost: m.cost === null ? null : Number(m.cost),
      batch: m.batch,
      expiry: m.expiry,
      staffEmail: m.staff_email,
      createdAt: m.created_at,
    };
  });
}

export type CreateMovementInput = {
  productId: string;
  type: LoggableMovementType;
  qty: number;
  cost?: number | null;
  batch?: string | null;
  expiry?: string | null;
};

function normalizeQty(type: LoggableMovementType, qty: number): number {
  if (type === "PURCHASE") return Math.abs(qty);
  if (type === "WASTE") return -Math.abs(qty);
  return qty;
}

export async function createMovement(
  supabase: SupabaseClient,
  clubId: string,
  input: CreateMovementInput,
): Promise<{ movement: Movement; newStock: number }> {
  if (!Number.isFinite(input.qty) || input.qty === 0) {
    throw new Error("Enter a valid, non-zero quantity");
  }

  // Defense-in-depth: RLS's inventory_moves INSERT policy only checks the
  // NEW row's own club_id — it doesn't verify product_id actually belongs
  // to that same club.
  const { data: product, error: productError } = await supabase
    .from("products")
    .select("id, name")
    .eq("id", input.productId)
    .eq("club_id", clubId)
    .maybeSingle();
  if (productError) throw productError;
  if (!product) throw new Error("Product not found in this club");

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const { data: membership, error: membershipError } = await supabase
    .from("club_users")
    .select("id")
    .eq("club_id", clubId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (membershipError) throw membershipError;
  if (!membership) throw new Error("Not a member of this club");

  const qty = normalizeQty(input.type, input.qty);

  const { data, error } = await supabase
    .from("inventory_moves")
    .insert({
      club_id: clubId,
      product_id: input.productId,
      type: input.type,
      qty,
      cost: input.cost ?? null,
      batch: input.batch || null,
      expiry: input.expiry || null,
      staff_id: membership.id,
      staff_email: user.email ?? null,
    })
    .select(MOVEMENT_COLUMNS)
    .single();
  if (error) throw error;

  const { data: stockRow } = await supabase
    .from("product_stock")
    .select("stock")
    .eq("product_id", input.productId)
    .eq("club_id", clubId)
    .maybeSingle();

  const m = data as MovementRow;
  const movement: Movement = {
    id: m.id,
    type: m.type,
    productId: m.product_id,
    productName: product.name as string,
    qty: Number(m.qty),
    cost: m.cost === null ? null : Number(m.cost),
    batch: m.batch,
    expiry: m.expiry,
    staffEmail: m.staff_email,
    createdAt: m.created_at,
  };

  return { movement, newStock: stockRow?.stock ?? 0 };
}
