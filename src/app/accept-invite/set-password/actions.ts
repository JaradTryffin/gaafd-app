"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveLandingPath } from "@/lib/auth/landing";

export async function setPassword(formData: FormData) {
  const password = String(formData.get("password") ?? "");

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    redirect(`/accept-invite/set-password?error=${encodeURIComponent(error.message)}`);
  }

  const landingPath = await resolveLandingPath(supabase);
  redirect(landingPath);
}
