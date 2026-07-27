import type { SupabaseClient } from "@supabase/supabase-js";

export async function resolveLandingPath(supabase: SupabaseClient): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "/login";

  const { data: platformRow } = await supabase
    .from("platform_users")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (platformRow) return "/platform";

  const { data: memberships } = await supabase
    .from("club_users")
    .select("club_id")
    .eq("user_id", user.id);
  const clubIds = (memberships ?? []).map((m) => m.club_id);

  if (clubIds.length === 0) return "/no-access";

  const { data: clubs } = await supabase.from("clubs").select("slug").in("id", clubIds);
  const slugs = (clubs ?? []).map((c) => c.slug);

  if (slugs.length === 1) return `/${slugs[0]}`;
  return "/select-club";
}
