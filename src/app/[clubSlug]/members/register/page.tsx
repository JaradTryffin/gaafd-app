import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import { RegisterMemberForm } from "./register-form";

export default async function RegisterMemberPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const supabase = await createClient();
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();

  const { data: members } = await supabase
    .from("members")
    .select("id, first, last, code")
    .eq("club_id", access.clubId)
    .order("first", { ascending: true });

  return (
    <RegisterMemberForm clubSlug={clubSlug} clubId={access.clubId} existingMembers={members ?? []} />
  );
}
