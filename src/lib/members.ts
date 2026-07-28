import type { SupabaseClient } from "@supabase/supabase-js";

export type RegisterMemberInput = {
  clubId: string;
  first: string;
  last: string;
  type: "Full member" | "Day pass" | "Trial";
  status?: "active" | "inactive";
  phone?: string;
  email?: string;
  appHandle?: string;
  referrerId?: string;
};

async function nextMemberCode(supabase: SupabaseClient, clubId: string): Promise<string> {
  const { data: club, error: clubError } = await supabase
    .from("clubs")
    .select("initials")
    .eq("id", clubId)
    .single();
  if (clubError) throw clubError;

  const { count, error: countError } = await supabase
    .from("members")
    .select("id", { count: "exact", head: true })
    .eq("club_id", clubId);
  if (countError) throw countError;

  const sequence = (count ?? 0) + 1;
  return `${club.initials}-${String(sequence).padStart(4, "0")}`;
}

export async function registerMember(
  supabase: SupabaseClient,
  input: RegisterMemberInput,
): Promise<{ memberId: string; code: string }> {
  const code = await nextMemberCode(supabase, input.clubId);
  const { data, error } = await supabase
    .from("members")
    .insert({
      club_id: input.clubId,
      code,
      first: input.first,
      last: input.last,
      type: input.type,
      status: input.status ?? "active",
      phone: input.phone || null,
      email: input.email || null,
      app_handle: input.appHandle || null,
      referrer_id: input.referrerId || null,
    })
    .select("id, code")
    .single();
  if (error) throw error;
  return { memberId: data.id, code: data.code };
}
