import type { SupabaseClient } from "@supabase/supabase-js";
import { sastDayRange } from "@/lib/format";
import { assertClubAdmin } from "@/lib/auth/require-role";

export type BusinessDay = {
  id: string;
  initialFloat: number;
  openedAt: string;
  openedByEmail: string;
  closedAt: string | null;
  closedByEmail: string | null;
  cashCounted: number | null;
  status: "open" | "closed";
};

export type Workstation = {
  id: string;
  name: string;
  active: boolean;
};

export type Shift = {
  id: string;
  staffId: string | null;
  staffEmail: string;
  workstationId: string | null;
  workstationName: string | null;
  clockIn: string;
  clockOut: string | null;
  cashOut: number | null;
  status: "open" | "closed";
};

type BusinessDayRow = {
  id: string;
  initial_float: number;
  opened_at: string;
  opened_by_email: string;
  closed_at: string | null;
  closed_by_email: string | null;
  cash_counted: number | null;
  status: "open" | "closed";
};

const BUSINESS_DAY_COLUMNS =
  "id, initial_float, opened_at, opened_by_email, closed_at, closed_by_email, cash_counted, status";

function mapBusinessDay(row: BusinessDayRow): BusinessDay {
  return {
    id: row.id,
    initialFloat: Number(row.initial_float),
    openedAt: row.opened_at,
    openedByEmail: row.opened_by_email,
    closedAt: row.closed_at,
    closedByEmail: row.closed_by_email,
    cashCounted: row.cash_counted === null ? null : Number(row.cash_counted),
    status: row.status,
  };
}

export async function getOpenBusinessDay(supabase: SupabaseClient, clubId: string): Promise<BusinessDay | null> {
  const { data, error } = await supabase
    .from("business_days")
    .select(BUSINESS_DAY_COLUMNS)
    .eq("club_id", clubId)
    .eq("status", "open")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return mapBusinessDay(data as BusinessDayRow);
}

export async function getWorkstations(supabase: SupabaseClient, clubId: string): Promise<Workstation[]> {
  const { data, error } = await supabase
    .from("workstations")
    .select("id, name, active")
    .eq("club_id", clubId)
    .order("name", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    active: row.active as boolean,
  }));
}

type ShiftRow = {
  id: string;
  staff_id: string | null;
  staff_email: string;
  workstation_id: string | null;
  clock_in: string;
  clock_out: string | null;
  cash_out: number | null;
};

function mapShiftRow(row: ShiftRow, workstationName: string | null): Shift {
  return {
    id: row.id,
    staffId: row.staff_id,
    staffEmail: row.staff_email,
    workstationId: row.workstation_id,
    workstationName,
    clockIn: row.clock_in,
    clockOut: row.clock_out,
    cashOut: row.cash_out === null ? null : Number(row.cash_out),
    status: row.clock_out === null ? "open" : "closed",
  };
}

export async function getShiftsForDay(
  supabase: SupabaseClient,
  clubId: string,
  businessDayId: string,
): Promise<Shift[]> {
  const { data: rows, error } = await supabase
    .from("shifts")
    .select("id, staff_id, staff_email, workstation_id, clock_in, clock_out, cash_out")
    .eq("club_id", clubId)
    .eq("business_day_id", businessDayId)
    .order("clock_in", { ascending: false });
  if (error) throw error;

  const list = (rows ?? []) as ShiftRow[];
  if (list.length === 0) return [];

  const workstationIds = [
    ...new Set(list.map((r) => r.workstation_id).filter((id): id is string => id !== null)),
  ];
  let nameById = new Map<string, string>();
  if (workstationIds.length > 0) {
    const { data: workstations, error: wError } = await supabase
      .from("workstations")
      .select("id, name")
      .in("id", workstationIds);
    if (wError) throw wError;
    nameById = new Map((workstations ?? []).map((w) => [w.id as string, w.name as string]));
  }

  return list.map((row) =>
    mapShiftRow(row, row.workstation_id ? nameById.get(row.workstation_id) ?? "—" : null),
  );
}

export async function getCashDonationsToday(supabase: SupabaseClient, clubId: string): Promise<number> {
  const today = sastDayRange(0);
  const { data, error } = await supabase
    .from("donations")
    .select("amount_rand")
    .eq("club_id", clubId)
    .eq("method", "Cash")
    .gte("created_at", today.start)
    .lt("created_at", today.end);
  if (error) throw error;
  return (data ?? []).reduce((sum, row) => sum + Number(row.amount_rand), 0);
}

export async function openBusinessDay(
  supabase: SupabaseClient,
  clubId: string,
  initialFloat: number,
): Promise<BusinessDay> {
  await assertClubAdmin(supabase, clubId);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const { data: membership, error: membershipError } = await supabase
    .from("club_users")
    .select("id")
    .eq("club_id", clubId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (membershipError) throw membershipError;
  if (!membership) throw new Error("Not a member of this club");

  const { data, error } = await supabase
    .from("business_days")
    .insert({
      club_id: clubId,
      initial_float: initialFloat,
      opened_by: membership.id,
      opened_by_email: user.email ?? "",
    })
    .select(BUSINESS_DAY_COLUMNS)
    .single();
  if (error) throw error;
  return mapBusinessDay(data as BusinessDayRow);
}

export async function createWorkstation(
  supabase: SupabaseClient,
  clubId: string,
  name: string,
): Promise<Workstation> {
  await assertClubAdmin(supabase, clubId);
  const { data, error } = await supabase
    .from("workstations")
    .insert({ club_id: clubId, name })
    .select("id, name, active")
    .single();
  if (error) throw error;
  return { id: data.id as string, name: data.name as string, active: data.active as boolean };
}

export async function clockIn(
  supabase: SupabaseClient,
  clubId: string,
  workstationId: string | null,
): Promise<Shift> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const { data, error } = await supabase.rpc("clock_in", {
    p_club_id: clubId,
    p_workstation_id: workstationId,
    p_staff_email: user.email ?? "",
  });
  if (error) throw error;

  const row = data as ShiftRow;
  let workstationName: string | null = null;
  if (row.workstation_id) {
    const { data: workstation } = await supabase
      .from("workstations")
      .select("name")
      .eq("id", row.workstation_id)
      .maybeSingle();
    workstationName = workstation?.name ?? null;
  }
  return mapShiftRow(row, workstationName);
}

export async function clockOut(
  supabase: SupabaseClient,
  shiftId: string,
  cashOut: number,
  isForceClose: boolean,
): Promise<Shift> {
  const { data, error } = await supabase
    .from("shifts")
    .update({ clock_out: new Date().toISOString(), cash_out: cashOut, force_closed: isForceClose })
    .eq("id", shiftId)
    .is("clock_out", null)
    .select("id, staff_id, staff_email, workstation_id, clock_in, clock_out, cash_out")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Shift not found, already closed, or you don't have permission to close it");

  const row = data as ShiftRow;
  let workstationName: string | null = null;
  if (row.workstation_id) {
    const { data: workstation } = await supabase
      .from("workstations")
      .select("name")
      .eq("id", row.workstation_id)
      .maybeSingle();
    workstationName = workstation?.name ?? null;
  }
  return mapShiftRow(row, workstationName);
}

export async function closeBusinessDay(
  supabase: SupabaseClient,
  clubId: string,
  businessDayId: string,
): Promise<BusinessDay> {
  await assertClubAdmin(supabase, clubId);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const { data, error } = await supabase.rpc("close_business_day", {
    p_club_id: clubId,
    p_business_day_id: businessDayId,
    p_staff_email: user.email ?? "",
  });
  if (error) throw error;
  return mapBusinessDay(data as BusinessDayRow);
}
