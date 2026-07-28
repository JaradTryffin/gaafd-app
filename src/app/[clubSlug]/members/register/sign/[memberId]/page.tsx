import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import { getOrCreateContractTemplate } from "@/lib/contracts";
import { SignAgreementForm } from "./sign-form";

export default async function SignAgreementPage({
  params,
}: {
  params: Promise<{ clubSlug: string; memberId: string }>;
}) {
  const { clubSlug, memberId } = await params;
  const supabase = await createClient();
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();

  const { data: member } = await supabase
    .from("members")
    .select("id, first, last")
    .eq("id", memberId)
    .eq("club_id", access.clubId)
    .maybeSingle();
  if (!member) notFound();

  const template = await getOrCreateContractTemplate(supabase, access.clubId, access.name);

  return (
    <SignAgreementForm
      clubSlug={clubSlug}
      clubId={access.clubId}
      clubName={access.name}
      memberId={member.id}
      memberName={`${member.first} ${member.last}`}
      template={template}
    />
  );
}
