"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { registerMember } from "@/lib/members";

export async function registerMemberAction(input: {
  clubSlug: string;
  clubId: string;
  first: string;
  last: string;
  email?: string;
  phone?: string;
  type: "Full member" | "Day pass" | "Trial";
  status: "active" | "inactive";
  referrerId?: string;
  appHandle?: string;
}): Promise<{ error: string } | void> {
  const supabase = await createClient();

  let memberId: string;
  try {
    const result = await registerMember(supabase, input);
    memberId = result.memberId;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to register member" };
  }

  redirect(`/${input.clubSlug}/members/register/sign/${memberId}`);
}
