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

  const { data: existingCodes, error: codesError } = await supabase
    .from("members")
    .select("code")
    .eq("club_id", clubId)
    .like("code", `${club.initials}-%`);
  if (codesError) throw codesError;

  const maxSequence = (existingCodes ?? []).reduce((max, row) => {
    const match = /-(\d{4})$/.exec(row.code as string);
    if (!match) return max;
    return Math.max(max, Number(match[1]));
  }, 0);

  return `${club.initials}-${String(maxSequence + 1).padStart(4, "0")}`;
}

export async function registerMember(
  supabase: SupabaseClient,
  input: RegisterMemberInput,
): Promise<{ memberId: string; code: string }> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
    if (!error) {
      return { memberId: data.id, code: data.code };
    }
    // unique_violation on (club_id, code) — another registration raced us
    // (or a deletion left a gap that made two computed sequences collide).
    // Retry with a freshly recomputed code rather than surfacing a
    // spurious error to the person registering a member.
    if (error.code === "23505" && attempt < MAX_ATTEMPTS) {
      continue;
    }
    throw error;
  }
  throw new Error("Failed to generate a unique member code after multiple attempts");
}

export type MemberListRow = {
  id: string;
  first: string;
  last: string;
  code: string;
  type: "Full member" | "Day pass" | "Trial";
  tokenBalance: number;
  referrerName: string | null;
  status: "active" | "inactive";
};

export async function listMembers(
  supabase: SupabaseClient,
  clubId: string,
): Promise<MemberListRow[]> {
  const { data, error } = await supabase
    .from("members")
    .select("id, first, last, code, type, token_balance, referrer_id, status")
    .eq("club_id", clubId)
    .order("joined_at", { ascending: false });
  if (error) throw error;

  const rows = data ?? [];
  // A referrer is always another member of the same club, already present
  // in this same result set — no second query needed.
  const nameById = new Map(rows.map((m) => [m.id as string, `${m.first} ${m.last}`]));

  return rows.map((m) => ({
    id: m.id as string,
    first: m.first as string,
    last: m.last as string,
    code: m.code as string,
    type: m.type as "Full member" | "Day pass" | "Trial",
    tokenBalance: m.token_balance as number,
    referrerName: m.referrer_id ? (nameById.get(m.referrer_id as string) ?? null) : null,
    status: m.status as "active" | "inactive",
  }));
}
