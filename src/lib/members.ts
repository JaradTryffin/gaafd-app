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
  idFront?: File | null;
  idBack?: File | null;
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

function extensionForFile(file: File): string {
  if (file.type === "image/png") return "png";
  if (file.type === "image/heic" || file.type === "image/heif") return "heic";
  return "jpg";
}

async function uploadIdPhoto(
  supabase: SupabaseClient,
  clubId: string,
  memberId: string,
  side: "front" | "back",
  file: File,
): Promise<string | null> {
  const path = `${clubId}/${memberId}/${side}.${extensionForFile(file)}`;
  const { error } = await supabase.storage
    .from("member-ids")
    .upload(path, file, { contentType: file.type || "image/jpeg", upsert: true });
  if (error) {
    console.error(`Failed to upload ID ${side} photo for member ${memberId}:`, error);
    return null;
  }
  return path;
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
      const memberId = data.id as string;
      const updates: { id_front_url?: string; id_back_url?: string } = {};
      if (input.idFront) {
        const path = await uploadIdPhoto(supabase, input.clubId, memberId, "front", input.idFront);
        if (path) updates.id_front_url = path;
      }
      if (input.idBack) {
        const path = await uploadIdPhoto(supabase, input.clubId, memberId, "back", input.idBack);
        if (path) updates.id_back_url = path;
      }
      if (Object.keys(updates).length > 0) {
        const { error: updateError } = await supabase
          .from("members")
          .update(updates)
          .eq("id", memberId);
        if (updateError) {
          console.error(`Failed to save ID photo path(s) for member ${memberId}:`, updateError);
        }
      }
      return { memberId, code: data.code as string };
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
