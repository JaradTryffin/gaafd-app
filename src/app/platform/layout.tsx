import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolvePlatformAccess } from "@/lib/auth/club-access";

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const hasAccess = await resolvePlatformAccess(supabase);
  if (!hasAccess) {
    notFound();
  }

  return <>{children}</>;
}
