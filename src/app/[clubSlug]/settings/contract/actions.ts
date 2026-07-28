"use server";

import { createClient } from "@/lib/supabase/server";
import {
  saveContractTemplate,
  resetContractTemplate,
  type ContractClause,
  type ContractTemplate,
} from "@/lib/contracts";

export async function saveContractTemplateAction(
  clubId: string,
  input: { title: string; subtitle: string; consent: string; clauses: ContractClause[] },
): Promise<{ ok: true; template: ContractTemplate } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const template = await saveContractTemplate(supabase, clubId, input);
    return { ok: true, template };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to save" };
  }
}

export async function resetContractTemplateAction(
  clubId: string,
  clubName: string,
): Promise<{ ok: true; template: ContractTemplate } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const template = await resetContractTemplate(supabase, clubId, clubName);
    return { ok: true, template };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to reset" };
  }
}
