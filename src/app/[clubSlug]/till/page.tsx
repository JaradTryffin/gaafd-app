import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import { getOpenBusinessDay, getWorkstations, getShiftsForDay, getCashDonationsToday } from "@/lib/till";
import { TillHeader } from "./till-header";
import { TillPanel } from "./till-panel";

export default async function TillPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const supabase = await createClient();
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const businessDay = await getOpenBusinessDay(supabase, access.clubId);

  const [workstations, shifts, cashDonationsToday] = await Promise.all([
    getWorkstations(supabase, access.clubId),
    businessDay ? getShiftsForDay(supabase, access.clubId, businessDay.id) : Promise.resolve([]),
    getCashDonationsToday(supabase, access.clubId),
  ]);

  return (
    <>
      <TillHeader />
      <TillPanel
        clubId={access.clubId}
        currentUserEmail={user?.email ?? ""}
        businessDay={businessDay}
        workstations={workstations}
        shifts={shifts}
        cashDonationsToday={cashDonationsToday}
      />
    </>
  );
}
