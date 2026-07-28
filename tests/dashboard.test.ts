import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedTenants, cleanupTenants, signInAs, type SeededData } from "./rls/fixtures";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getDashboardKpis,
  getLowStockAlerts,
  getRecentActivity,
  LOW_STOCK_THRESHOLD,
} from "@/lib/dashboard";

let data: SeededData;
let clubAClient: SupabaseClient;
let clubBClient: SupabaseClient;
const cleanupMemberIds: string[] = [];
const cleanupDonationIds: string[] = [];
const cleanupMoveIds: string[] = [];

beforeAll(async () => {
  data = await seedTenants();
  clubAClient = await signInAs(data.clubA.adminEmail, data.clubA.adminPassword);
  clubBClient = await signInAs(data.clubB.adminEmail, data.clubB.adminPassword);
}, 30000);

afterAll(async () => {
  const admin = createAdminClient();
  if (cleanupMoveIds.length > 0) {
    await admin.from("inventory_moves").delete().in("id", cleanupMoveIds);
  }
  if (cleanupDonationIds.length > 0) {
    await admin.from("donations").delete().in("id", cleanupDonationIds);
  }
  if (cleanupMemberIds.length > 0) {
    await admin.from("members").delete().in("id", cleanupMemberIds);
  }
  if (data) {
    await cleanupTenants(data);
  }
}, 30000);

describe("getDashboardKpis", () => {
  it("counts active members and this month's new members, as a delta over the fixture baseline", async () => {
    // seedClub() already creates one active member per club, so the
    // baseline isn't zero — assert the delta after adding one more.
    const before = await getDashboardKpis(clubAClient, data.clubA.clubId);

    const admin = createAdminClient();
    const { data: newMember, error } = await admin
      .from("members")
      .insert({
        club_id: data.clubA.clubId,
        code: "DASH-TEST-0001",
        first: "Dash",
        last: "Kpi",
        type: "Full member",
        status: "active",
      })
      .select()
      .single();
    if (error) throw error;
    cleanupMemberIds.push(newMember.id);

    const after = await getDashboardKpis(clubAClient, data.clubA.clubId);
    expect(after.activeMembers).toBe(before.activeMembers + 1);
    expect(after.newMembersThisMonth).toBe(before.newMembersThisMonth + 1);
  });

  it("sums today's donations as a delta over the fixture baseline", async () => {
    // seedClub() also seeds one R300 donation at "now" per club, already
    // inside today's window and included in `before`.
    const before = await getDashboardKpis(clubAClient, data.clubA.clubId);

    const admin = createAdminClient();
    const { data: donation, error } = await admin
      .from("donations")
      .insert({
        club_id: data.clubA.clubId,
        member_id: data.clubA.memberId,
        amount_rand: 150,
        method: "Card",
        tokens_credited: 150,
      })
      .select()
      .single();
    if (error) throw error;
    cleanupDonationIds.push(donation.id);

    const after = await getDashboardKpis(clubAClient, data.clubA.clubId);
    expect(after.donationsTodayRand).toBe(before.donationsTodayRand + 150);
  });

  it("does not leak club A's new members or donations into club B's KPIs", async () => {
    const clubBBefore = await getDashboardKpis(clubBClient, data.clubB.clubId);

    const admin = createAdminClient();
    const { data: extraMember, error: memberError } = await admin
      .from("members")
      .insert({
        club_id: data.clubA.clubId,
        code: "DASH-TEST-ISO-0001",
        first: "Isolation",
        last: "Check",
        type: "Full member",
        status: "active",
      })
      .select()
      .single();
    if (memberError) throw memberError;
    cleanupMemberIds.push(extraMember.id);

    const { data: extraDonation, error: donationError } = await admin
      .from("donations")
      .insert({
        club_id: data.clubA.clubId,
        member_id: data.clubA.memberId,
        amount_rand: 500,
        method: "EFT",
        tokens_credited: 500,
      })
      .select()
      .single();
    if (donationError) throw donationError;
    cleanupDonationIds.push(extraDonation.id);

    const clubBAfter = await getDashboardKpis(clubBClient, data.clubB.clubId);
    expect(clubBAfter.activeMembers).toBe(clubBBefore.activeMembers);
    expect(clubBAfter.donationsTodayRand).toBe(clubBBefore.donationsTodayRand);
  });

  it("reports zero low-stock items when every product is well-stocked", async () => {
    // seedClub()'s fixture product has a PURCHASE move of qty 100, far
    // above LOW_STOCK_THRESHOLD.
    const kpis = await getDashboardKpis(clubAClient, data.clubA.clubId);
    expect(kpis.lowStockCount).toBe(0);
  });

  it("counts a product once its derived stock drops to the low-stock threshold", async () => {
    const admin = createAdminClient();
    const { data: move, error } = await admin
      .from("inventory_moves")
      .insert({
        club_id: data.clubA.clubId,
        product_id: data.clubA.productId,
        type: "SALE",
        qty: -95, // fixture product started at 100 -> now 5, <= threshold
      })
      .select()
      .single();
    if (error) throw error;
    cleanupMoveIds.push(move.id);

    const kpis = await getDashboardKpis(clubAClient, data.clubA.clubId);
    expect(kpis.lowStockCount).toBe(1);
  });
});

describe("getLowStockAlerts", () => {
  // Depends on the previous describe block's stock-depleting move having
  // already run — Vitest runs `it` blocks within a file in declaration
  // order, and this codebase's other test files already rely on that
  // (see tests/contracts.test.ts).
  it("lists the low-stock product with its current stock, sorted lowest first", async () => {
    const alerts = await getLowStockAlerts(clubAClient, data.clubA.clubId, 5);
    const fixtureAlert = alerts.find((a) => a.productId === data.clubA.productId);
    expect(fixtureAlert).toBeDefined();
    expect(fixtureAlert!.stock).toBeLessThanOrEqual(LOW_STOCK_THRESHOLD);
    expect(fixtureAlert!.name).toBe("Test Product");
  });

  it("does not return club A's low-stock product to club B", async () => {
    const clubBAlerts = await getLowStockAlerts(clubBClient, data.clubB.clubId, 5);
    const ids = clubBAlerts.map((a) => a.productId);
    expect(ids).not.toContain(data.clubA.productId);
  });
});

describe("getRecentActivity", () => {
  it("merges donations and member registrations newest-first, scoped to the caller's club", async () => {
    const admin = createAdminClient();
    const { data: newMember, error: memberError } = await admin
      .from("members")
      .insert({
        club_id: data.clubA.clubId,
        code: "DASH-TEST-0002",
        first: "Activity",
        last: "Newest",
        type: "Trial",
        status: "active",
      })
      .select()
      .single();
    if (memberError) throw memberError;
    cleanupMemberIds.push(newMember.id);

    const activity = await getRecentActivity(clubAClient, data.clubA.clubId, 10);
    // The just-inserted member has the newest timestamp of anything
    // seeded so far in this file, so it must be first.
    expect(activity[0]).toMatchObject({ kind: "member", id: newMember.id });

    // No club B row id should ever appear in club A's feed.
    const ids = activity.map((a) => a.id);
    expect(ids).not.toContain(data.clubB.memberId);
    expect(ids).not.toContain(data.clubB.donationId);
  });
});
