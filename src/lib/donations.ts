import type { SupabaseClient } from "@supabase/supabase-js";
import { sastDayRange } from "@/lib/format";

export type DonationMethod = "Cash" | "Card" | "EFT";

export type Donation = {
  id: string;
  memberId: string;
  memberName: string;
  amountRand: number;
  method: DonationMethod;
  tokensCredited: number;
  createdAt: string;
};

type DonationRow = {
  id: string;
  member_id: string;
  amount_rand: number;
  method: DonationMethod;
  tokens_credited: number;
  created_at: string;
};

export async function getTodaysDonations(supabase: SupabaseClient, clubId: string): Promise<Donation[]> {
  const today = sastDayRange(0);
  const { data: rows, error } = await supabase
    .from("donations")
    .select("id, member_id, amount_rand, method, tokens_credited, created_at")
    .eq("club_id", clubId)
    .gte("created_at", today.start)
    .lt("created_at", today.end)
    .order("created_at", { ascending: false });
  if (error) throw error;

  const list = rows ?? [];
  if (list.length === 0) return [];

  const memberIds = [...new Set(list.map((r) => r.member_id as string))];
  const { data: members, error: membersError } = await supabase
    .from("members")
    .select("id, first, last")
    .in("id", memberIds);
  if (membersError) throw membersError;
  const nameById = new Map((members ?? []).map((m) => [m.id as string, `${m.first} ${m.last}`]));

  return list.map((row) => {
    const r = row as DonationRow;
    return {
      id: r.id,
      memberId: r.member_id,
      memberName: nameById.get(r.member_id) ?? "—",
      amountRand: Number(r.amount_rand),
      method: r.method,
      tokensCredited: r.tokens_credited,
      createdAt: r.created_at,
    };
  });
}

export type RecordDonationInput = {
  memberId: string;
  amountRand: number;
  method: DonationMethod;
};

export async function recordDonation(
  supabase: SupabaseClient,
  clubId: string,
  input: RecordDonationInput,
): Promise<Donation> {
  const { data, error } = await supabase.rpc("record_donation", {
    p_club_id: clubId,
    p_member_id: input.memberId,
    p_amount_rand: input.amountRand,
    p_method: input.method,
  });
  if (error) throw error;

  // The function is declared `returns donations` (a single composite
  // row, not `setof donations`), so PostgREST/supabase-js returns
  // `data` as a single object here, not an array — unlike every other
  // Supabase call in this codebase so far (all `.from(...)` table
  // queries, which return arrays).
  const row = data as DonationRow;

  const { data: member } = await supabase
    .from("members")
    .select("first, last")
    .eq("id", row.member_id)
    .maybeSingle();

  return {
    id: row.id,
    memberId: row.member_id,
    memberName: member ? `${member.first} ${member.last}` : "—",
    amountRand: Number(row.amount_rand),
    method: row.method,
    tokensCredited: row.tokens_credited,
    createdAt: row.created_at,
  };
}
