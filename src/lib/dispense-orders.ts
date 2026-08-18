import type { SupabaseClient } from "@supabase/supabase-js";
import type { DispenseOrderItem } from "@/lib/dispensing";

export type DispenseOrderHistoryItem = DispenseOrderItem;

export type DispenseOrderHistoryRow = {
  id: string;
  memberId: string;
  memberName: string;
  staffEmail: string | null;
  tokenTotal: number;
  items: DispenseOrderHistoryItem[];
  hasGift: boolean;
  createdAt: string;
};

type DispenseOrderHistoryDbRow = {
  id: string;
  member_id: string;
  staff_email: string | null;
  token_total: number;
  items: DispenseOrderHistoryItem[];
  created_at: string;
};

export async function getDispenseOrders(
  supabase: SupabaseClient,
  clubId: string,
  filters?: { giftsOnly?: boolean },
): Promise<DispenseOrderHistoryRow[]> {
  const { data: rows, error } = await supabase
    .from("dispense_orders")
    .select("id, member_id, staff_email, token_total, items, created_at")
    .eq("club_id", clubId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;

  const list = (rows ?? []) as DispenseOrderHistoryDbRow[];
  if (list.length === 0) return [];

  const memberIds = [...new Set(list.map((r) => r.member_id))];
  const { data: members, error: membersError } = await supabase
    .from("members")
    .select("id, first, last")
    .in("id", memberIds);
  if (membersError) throw membersError;
  const nameById = new Map((members ?? []).map((m) => [m.id as string, `${m.first} ${m.last}`]));

  const mapped = list.map((row) => ({
    id: row.id,
    memberId: row.member_id,
    memberName: nameById.get(row.member_id) ?? "—",
    staffEmail: row.staff_email,
    tokenTotal: row.token_total,
    items: row.items,
    hasGift: row.items.some((i) => i.isGift),
    createdAt: row.created_at,
  }));

  return filters?.giftsOnly ? mapped.filter((o) => o.hasGift) : mapped;
}
