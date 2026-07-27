import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveLandingPath } from "@/lib/auth/landing";

export default async function RootPage() {
  const supabase = await createClient();
  const path = await resolveLandingPath(supabase);
  redirect(path);
}
