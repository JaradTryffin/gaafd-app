"use server";

import { createClient } from "@/lib/supabase/server";
import {
  openBusinessDay,
  clockIn,
  clockOut,
  closeBusinessDay,
  createWorkstation,
  type BusinessDay,
  type Shift,
  type Workstation,
} from "@/lib/till";

export async function openBusinessDayAction(
  clubId: string,
  initialFloat: number,
): Promise<{ ok: true; businessDay: BusinessDay } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const businessDay = await openBusinessDay(supabase, clubId, initialFloat);
    return { ok: true, businessDay };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to open business day" };
  }
}

export async function clockInAction(
  clubId: string,
  workstationId: string | null,
): Promise<{ ok: true; shift: Shift } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const shift = await clockIn(supabase, clubId, workstationId);
    return { ok: true, shift };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to clock in" };
  }
}

export async function clockOutAction(
  shiftId: string,
  cashOut: number,
  isForceClose: boolean,
): Promise<{ ok: true; shift: Shift } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const shift = await clockOut(supabase, shiftId, cashOut, isForceClose);
    return { ok: true, shift };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to clock out" };
  }
}

export async function closeBusinessDayAction(
  clubId: string,
  businessDayId: string,
): Promise<{ ok: true; businessDay: BusinessDay } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const businessDay = await closeBusinessDay(supabase, clubId, businessDayId);
    return { ok: true, businessDay };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to close business day" };
  }
}

export async function createWorkstationAction(
  clubId: string,
  name: string,
): Promise<{ ok: true; workstation: Workstation } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const workstation = await createWorkstation(supabase, clubId, name);
    return { ok: true, workstation };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to add workstation" };
  }
}
