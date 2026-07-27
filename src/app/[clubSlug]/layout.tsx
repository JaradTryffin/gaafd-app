import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ClubProvider } from "@/lib/club-context";

export default async function ClubLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  // RLS already scopes this to clubs the caller can access — a slug for a
  // club they don't belong to comes back empty here, not as a leaked row.
  const { data: club, error: clubError } = await supabase
    .from("clubs")
    .select("id, slug, name, initials, accent_color")
    .eq("slug", clubSlug)
    .maybeSingle();
  if (clubError || !club) {
    notFound();
  }

  // This is the definitive authorization check (not just a formality) — it
  // also gets us the role the rest of the app needs.
  const { data: membership } = await supabase
    .from("club_users")
    .select("role")
    .eq("club_id", club.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership) {
    notFound();
  }

  return (
    <ClubProvider
      value={{
        clubId: club.id,
        slug: club.slug,
        name: club.name,
        initials: club.initials,
        accentColor: club.accent_color,
        role: membership.role as "staff" | "admin",
      }}
    >
      {children}
    </ClubProvider>
  );
}
