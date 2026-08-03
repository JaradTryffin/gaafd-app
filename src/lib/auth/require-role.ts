import type { SupabaseClient } from "@supabase/supabase-js";

export async function assertClubAdmin(supabase: SupabaseClient, clubId: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const { data: membership, error } = await supabase
    .from("club_users")
    .select("role")
    .eq("club_id", clubId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) throw error;
  if (!membership || membership.role !== "admin") {
    throw new Error("Admin access required");
  }
}
