import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedTenants, cleanupTenants, signInAs, type SeededData } from "./rls/fixtures";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  openBusinessDay,
  clockIn,
  clockOut,
  closeBusinessDay,
  createWorkstation,
  getOpenBusinessDay,
  getShiftsForDay,
} from "@/lib/till";

let data: SeededData;
let clubAClient: SupabaseClient;
let clubBClient: SupabaseClient;
let staffClient: SupabaseClient;
let staffUserId: string;
const STAFF_PASSWORD = "Test-Password-123!";

beforeAll(async () => {
  data = await seedTenants();
  clubAClient = await signInAs(data.clubA.adminEmail, data.clubA.adminPassword);
  clubBClient = await signInAs(data.clubB.adminEmail, data.clubB.adminPassword);

  // The shared fixture only creates role: 'admin' club users. This
  // feature's cross-role RLS check (admin force-close vs. non-admin
  // rejected) needs a role: 'staff' identity, so seed one locally for
  // club A, matching dispensing.test.ts's precedent of local seeding for
  // scenarios the shared fixture doesn't cover.
  const admin = createAdminClient();
  const staffEmail = `till-staff-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const { data: staffAuth, error: staffAuthError } = await admin.auth.admin.createUser({
    email: staffEmail,
    password: STAFF_PASSWORD,
    email_confirm: true,
  });
  if (staffAuthError) throw staffAuthError;
  staffUserId = staffAuth.user.id;

  const { error: staffMembershipError } = await admin.from("club_users").insert({
    club_id: data.clubA.clubId,
    user_id: staffUserId,
    role: "staff",
  });
  if (staffMembershipError) throw staffMembershipError;

  staffClient = await signInAs(staffEmail, STAFF_PASSWORD);
}, 30000);

afterAll(async () => {
  const admin = createAdminClient();
  if (staffUserId) {
    await admin.auth.admin.deleteUser(staffUserId);
  }
  // clubs cascade-delete business_days/workstations/shifts (all
  // club_id -> clubs on delete cascade), so no separate cleanup needed
  // for rows created by the tests below.
  if (data) {
    await cleanupTenants(data);
  }
}, 30000);

describe("business day + shift lifecycle (club A)", () => {
  it("runs the full sequence: open, reject double-open, clock in/out, force-close, close day", async () => {
    // This sequence makes ~15 serial round-trips to the live Supabase
    // project (auth, membership checks, RPCs, updates) — well past
    // vitest's 5000ms default, same reasoning as beforeAll/afterAll's
    // explicit 30000ms below.
    const day = await openBusinessDay(clubAClient, data.clubA.clubId, 1500);
    expect(day.status).toBe("open");
    expect(day.initialFloat).toBe(1500);
    expect(day.openedByEmail).toBe(data.clubA.adminEmail);

    // Only one open business day per club at a time.
    await expect(openBusinessDay(clubAClient, data.clubA.clubId, 1000)).rejects.toThrow();

    const workstation = await createWorkstation(clubAClient, data.clubA.clubId, "Front desk");
    expect(workstation.name).toBe("Front desk");

    const staffShift = await clockIn(staffClient, data.clubA.clubId, workstation.id);
    expect(staffShift.status).toBe("open");
    expect(staffShift.staffEmail).toMatch(/^till-staff-.+@example\.test$/);
    expect(staffShift.workstationName).toBe("Front desk");

    // Same staff member can't clock in twice while already open.
    await expect(clockIn(staffClient, data.clubA.clubId, null)).rejects.toThrow();

    const adminShift = await clockIn(clubAClient, data.clubA.clubId, null);
    expect(adminShift.status).toBe("open");

    // Can't close the day while shifts are still open.
    await expect(closeBusinessDay(clubAClient, data.clubA.clubId, day.id)).rejects.toThrow();

    // A non-admin can't force-close someone else's shift — RLS matches
    // zero rows, which clockOut() surfaces as a thrown error.
    await expect(clockOut(staffClient, adminShift.id, 100, true)).rejects.toThrow();

    // An admin CAN force-close another staff member's shift.
    const forceClosed = await clockOut(clubAClient, staffShift.id, 300, true);
    expect(forceClosed.status).toBe("closed");
    expect(forceClosed.cashOut).toBe(300);

    // Admin clocks themselves out normally.
    const selfClosed = await clockOut(clubAClient, adminShift.id, 150, false);
    expect(selfClosed.status).toBe("closed");
    expect(selfClosed.cashOut).toBe(150);

    const closedDay = await closeBusinessDay(clubAClient, data.clubA.clubId, day.id);
    expect(closedDay.status).toBe("closed");
    expect(closedDay.cashCounted).toBe(450);

    const finalShifts = await getShiftsForDay(clubAClient, data.clubA.clubId, day.id);
    expect(finalShifts.every((s) => s.status === "closed")).toBe(true);
  }, 30000);
});

describe("cross-club isolation", () => {
  it("prevents club A from seeing or acting on club B's business day/shifts", async () => {
    await openBusinessDay(clubBClient, data.clubB.clubId, 800);
    await createWorkstation(clubBClient, data.clubB.clubId, "Lounge");
    await clockIn(clubBClient, data.clubB.clubId, null);

    // club A's session querying club B's clubId sees nothing — RLS
    // filters the row out entirely, it's not an error, just absent.
    const seenByA = await getOpenBusinessDay(clubAClient, data.clubB.clubId);
    expect(seenByA).toBeNull();

    // club A has no club_users row for club B, so clock_in's own
    // membership check rejects it before any write.
    await expect(clockIn(clubAClient, data.clubB.clubId, null)).rejects.toThrow();

    // Club B's business day/shift/workstation are left open here —
    // cleanupTenants' club deletion cascades them away regardless of
    // status, so no explicit close/cleanup is needed in this test.
  });
});

describe("role-based access", () => {
  it("rejects a staff-role user calling openBusinessDay/createWorkstation/closeBusinessDay, but admin still succeeds", async () => {
    await expect(openBusinessDay(staffClient, data.clubA.clubId, 500)).rejects.toThrow(
      "Admin access required",
    );

    const day = await openBusinessDay(clubAClient, data.clubA.clubId, 500);

    await expect(
      createWorkstation(staffClient, data.clubA.clubId, "Staff Attempt Workstation"),
    ).rejects.toThrow("Admin access required");

    const workstation = await createWorkstation(clubAClient, data.clubA.clubId, "Admin Workstation");
    expect(workstation.name).toBe("Admin Workstation");

    await expect(closeBusinessDay(staffClient, data.clubA.clubId, day.id)).rejects.toThrow(
      "Admin access required",
    );

    const closedDay = await closeBusinessDay(clubAClient, data.clubA.clubId, day.id);
    expect(closedDay.status).toBe("closed");
  });

  it("RLS itself rejects a direct staff INSERT on business_days and workstations, bypassing assertClubAdmin entirely", async () => {
    const { error: dayInsertError } = await staffClient.from("business_days").insert({
      club_id: data.clubA.clubId,
      initial_float: 999,
      opened_by_email: "staff-bypass-attempt@example.test",
    });
    expect(dayInsertError).not.toBeNull();

    const { error: workstationInsertError } = await staffClient.from("workstations").insert({
      club_id: data.clubA.clubId,
      name: "Staff Direct Insert Attempt",
    });
    expect(workstationInsertError).not.toBeNull();
  });
});
