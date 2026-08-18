import type { SupabaseClient } from "@supabase/supabase-js";

export type CartItem = { productId: string; qty: number; isGift?: boolean; giftReason?: string | null };

export type DispenseOrderItem = {
  productId: string;
  productName: string;
  unit: string;
  qty: number;
  tokenPrice: number;
  lineTotal: number;
  isGift: boolean;
  giftReason: string | null;
};

export type DispenseOrder = {
  id: string;
  memberId: string;
  tokenTotal: number;
  staffEmail: string | null;
  items: DispenseOrderItem[];
  createdAt: string;
};

type DispenseOrderRow = {
  id: string;
  member_id: string;
  token_total: number;
  staff_email: string | null;
  items: DispenseOrderItem[];
  created_at: string;
};

export async function createDispenseOrder(
  supabase: SupabaseClient,
  clubId: string,
  memberId: string,
  items: CartItem[],
): Promise<DispenseOrder> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const { data, error } = await supabase.rpc("create_dispense_order", {
    p_club_id: clubId,
    p_member_id: memberId,
    p_items: items.map((i) => ({
      product_id: i.productId,
      qty: i.qty,
      is_gift: i.isGift ?? false,
      gift_reason: i.giftReason ?? null,
    })),
    p_staff_email: user.email ?? null,
  });
  if (error) throw error;

  // The function is declared `returns dispense_orders` (a single
  // composite row, not `setof`), so `data` is a single object, not an
  // array — same pattern already established by record_donation.
  const row = data as DispenseOrderRow;
  return {
    id: row.id,
    memberId: row.member_id,
    tokenTotal: row.token_total,
    staffEmail: row.staff_email,
    items: row.items,
    createdAt: row.created_at,
  };
}
