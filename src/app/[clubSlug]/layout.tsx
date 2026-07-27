import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
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

  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) {
    notFound();
  }

  return (
    <ClubProvider
      value={{
        clubId: access.clubId,
        slug: access.slug,
        name: access.name,
        initials: access.initials,
        accentColor: access.accentColor,
        role: access.role,
      }}
    >
      {children}
    </ClubProvider>
  );
}
