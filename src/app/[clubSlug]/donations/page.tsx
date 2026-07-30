import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import { listMembers } from "@/lib/members";
import { getTodaysDonations } from "@/lib/donations";
import { DonationsHeader } from "./donations-header";
import { DonationsPanel } from "./donations-panel";

export default async function DonationsPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const supabase = await createClient();
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();

  const [members, donations] = await Promise.all([
    listMembers(supabase, access.clubId),
    getTodaysDonations(supabase, access.clubId),
  ]);

  return (
    <>
      <DonationsHeader />
      <DonationsPanel clubId={access.clubId} members={members} donations={donations} />
    </>
  );
}
