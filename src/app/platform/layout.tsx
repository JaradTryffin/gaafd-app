import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const { data: platformRow } = await supabase
    .from("platform_users")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!platformRow) {
    notFound();
  }

  return <>{children}</>;
}
