"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signContract, type ContractTemplate } from "@/lib/contracts";

export async function completeSignAction(input: {
  clubSlug: string;
  clubId: string;
  memberId: string;
  printedName: string;
  consent: boolean;
  signaturePngBase64: string;
  template: Pick<ContractTemplate, "title" | "subtitle" | "consent" | "clauses" | "version">;
}): Promise<{ error: string } | void> {
  const supabase = await createClient();

  try {
    await signContract(supabase, input);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to sign" };
  }

  redirect(`/${input.clubSlug}/members/register/success?memberId=${input.memberId}`);
}
