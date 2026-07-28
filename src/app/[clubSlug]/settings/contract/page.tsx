import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import { getOrCreateContractTemplate } from "@/lib/contracts";
import { ContractEditor } from "./contract-editor";

export default async function ContractTemplatePage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const supabase = await createClient();
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();

  const template = await getOrCreateContractTemplate(supabase, access.clubId, access.name);

  return <ContractEditor initialTemplate={template} />;
}
