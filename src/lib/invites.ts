import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

export async function inviteStaffToClub(
  supabase: SupabaseClient,
  clubId: string,
  staffEmail: string,
): Promise<{ userId: string }> {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    throw new Error("Not authenticated");
  }

  const { data: membership, error: membershipError } = await supabase
    .from("club_users")
    .select("role")
    .eq("club_id", clubId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (membershipError) throw membershipError;
  if (membership?.role !== "admin") {
    throw new Error("Only a club admin can invite staff into this club");
  }

  const admin = createAdminClient();
  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(
    staffEmail,
  );
  if (inviteError) throw inviteError;

  const { error: insertError } = await admin.from("club_users").insert({
    club_id: clubId,
    user_id: invited.user.id,
    role: "staff",
  });
  if (insertError) throw insertError;

  return { userId: invited.user.id };
}

export async function createClubAndInviteAdmin(
  supabase: SupabaseClient,
  input: {
    slug: string;
    name: string;
    initials: string;
    plan: "Trial" | "Starter" | "Growth" | "Enterprise";
    region: string;
    accentColor: string;
    adminEmail: string;
  },
): Promise<{ clubId: string; adminUserId: string }> {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    throw new Error("Not authenticated");
  }

  const { data: platformRow, error: platformError } = await supabase
    .from("platform_users")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (platformError) throw platformError;
  if (!platformRow) {
    throw new Error("Only the platform operator can onboard a new club");
  }

  const admin = createAdminClient();
  const { data: club, error: clubError } = await admin
    .from("clubs")
    .insert({
      slug: input.slug,
      name: input.name,
      initials: input.initials,
      plan: input.plan,
      region: input.region,
      accent_color: input.accentColor,
      status: "trial",
    })
    .select()
    .single();
  if (clubError) throw clubError;

  try {
    const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(
      input.adminEmail,
    );
    if (inviteError) throw inviteError;

    const { error: insertError } = await admin.from("club_users").insert({
      club_id: club.id,
      user_id: invited.user.id,
      role: "admin",
    });
    if (insertError) throw insertError;

    return { clubId: club.id, adminUserId: invited.user.id };
  } catch (err) {
    // Roll back the club row so a partial failure doesn't leave an
    // orphaned, admin-less club behind.
    await admin.from("clubs").delete().eq("id", club.id);
    throw err;
  }
}
