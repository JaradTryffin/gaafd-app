import type { SupabaseClient } from "@supabase/supabase-js";

export type ClubAccess = {
  clubId: string;
  slug: string;
  name: string;
  initials: string;
  accentColor: string;
  role: "staff" | "admin";
};

export async function resolveClubAccess(
  supabase: SupabaseClient,
  slug: string,
): Promise<ClubAccess | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // RLS already scopes this to clubs the caller can access — a slug for a
  // club they don't belong to comes back empty here, not as a leaked row.
  const { data: club, error: clubError } = await supabase
    .from("clubs")
    .select("id, slug, name, initials, accent_color")
    .eq("slug", slug)
    .maybeSingle();
  if (clubError || !club) return null;

  // This is the definitive authorization check (not just a formality) — it
  // also supplies the role callers need.
  const { data: membership } = await supabase
    .from("club_users")
    .select("role")
    .eq("club_id", club.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership) return null;

  return {
    clubId: club.id,
    slug: club.slug,
    name: club.name,
    initials: club.initials,
    accentColor: club.accent_color,
    role: membership.role as "staff" | "admin",
  };
}

export async function resolvePlatformAccess(supabase: SupabaseClient): Promise<boolean> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;

  const { data: platformRow } = await supabase
    .from("platform_users")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  return Boolean(platformRow);
}
