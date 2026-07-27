import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess, listUserClubs } from "@/lib/auth/club-access";
import { ClubProvider } from "@/lib/club-context";
import { ToastProvider } from "@/lib/toast-context";
import { PageHeaderProvider } from "@/lib/page-header-context";
import { Sidebar } from "@/components/app-shell/sidebar";
import { AppHeader } from "@/components/app-shell/header";

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

  const clubs = await listUserClubs(supabase);

  return (
    <ClubProvider
      value={{
        clubId: access.clubId,
        slug: access.slug,
        name: access.name,
        initials: access.initials,
        accentColor: access.accentColor,
        plan: access.plan,
        role: access.role,
      }}
    >
      <ToastProvider>
        <PageHeaderProvider>
          <div className="flex h-screen w-full overflow-hidden font-sans text-[14px] leading-[1.45] text-foreground">
            <Sidebar clubs={clubs} userEmail={user.email ?? ""} />
            <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <AppHeader />
              <div className="flex-1 overflow-y-auto px-7 py-6">{children}</div>
            </main>
          </div>
        </PageHeaderProvider>
      </ToastProvider>
    </ClubProvider>
  );
}
