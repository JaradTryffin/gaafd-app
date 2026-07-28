import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import { listMembers } from "@/lib/members";
import { MembersHeader } from "./members-header";
import { MembersTable } from "./members-table";

export default async function MembersPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const supabase = await createClient();
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();

  const members = await listMembers(supabase, access.clubId);

  return (
    <>
      <MembersHeader clubName={access.name} count={members.length} />
      <MembersTable clubSlug={clubSlug} members={members} />
    </>
  );
}
