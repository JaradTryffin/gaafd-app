import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import { getOpenBusinessDay, getWorkstations, getShiftsForDay, getCashDonationsToday } from "@/lib/till";
import { TillHeader } from "./till-header";
import { TillPanel } from "./till-panel";
import { StaffClockPanel } from "./staff-clock-panel";

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

  if (access.role !== "admin") {
    const workstations = await getWorkstations(supabase, access.clubId);
    const shifts = businessDay ? await getShiftsForDay(supabase, access.clubId, businessDay.id) : [];
    const myShift = shifts.find((s) => s.staffEmail === user?.email && s.status === "open") ?? null;

    return (
      <>
        <TillHeader />
        <StaffClockPanel
          clubId={access.clubId}
          isDayOpen={businessDay !== null}
          workstations={workstations}
          myShift={myShift}
        />
      </>
    );
  }

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
