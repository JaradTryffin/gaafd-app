import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedTenants, cleanupTenants, signInAs, type SeededData } from "./rls/fixtures";
import { createAdminClient } from "@/lib/supabase/admin";
import { listMembers } from "@/lib/members";

let data: SeededData;
let clubAClient: SupabaseClient;
const cleanupMemberIds: string[] = [];

beforeAll(async () => {
  data = await seedTenants();
  clubAClient = await signInAs(data.clubA.adminEmail, data.clubA.adminPassword);
}, 30000);

afterAll(async () => {
  const admin = createAdminClient();
  if (cleanupMemberIds.length > 0) {
    await admin.from("members").delete().in("id", cleanupMemberIds);
  }
  if (data) {
    await cleanupTenants(data);
  }
}, 30000);

describe("listMembers", () => {
  it("returns only the caller's club's members, not club B's", async () => {
    const members = await listMembers(clubAClient, data.clubA.clubId);
    const ids = members.map((m) => m.id);
    expect(ids).not.toContain(data.clubB.memberId);
    // seedClub()'s own fixture member for club A must be present.
    expect(ids).toContain(data.clubA.memberId);
  });

  it("resolves a referrer's name from another member in the same list", async () => {
    const admin = createAdminClient();
    const { data: referrer, error: referrerError } = await admin
      .from("members")
      .insert({
        club_id: data.clubA.clubId,
        code: "MEM-TEST-0001",
        first: "Referrer",
        last: "One",
        type: "Full member",
        status: "active",
      })
      .select()
      .single();
    if (referrerError) throw referrerError;
    cleanupMemberIds.push(referrer.id);

    const { data: referred, error: referredError } = await admin
      .from("members")
      .insert({
        club_id: data.clubA.clubId,
        code: "MEM-TEST-0002",
        first: "Referred",
        last: "Two",
        type: "Trial",
        status: "active",
        referrer_id: referrer.id,
      })
      .select()
      .single();
    if (referredError) throw referredError;
    cleanupMemberIds.push(referred.id);

    const members = await listMembers(clubAClient, data.clubA.clubId);
    const referredRow = members.find((m) => m.id === referred.id);
    expect(referredRow).toBeDefined();
    expect(referredRow!.referrerName).toBe("Referrer One");
  });

  it("returns null referrerName when a member has no referrer", async () => {
    const members = await listMembers(clubAClient, data.clubA.clubId);
    // seedClub()'s own fixture member is never given a referrer.
    const fixtureRow = members.find((m) => m.id === data.clubA.memberId);
    expect(fixtureRow).toBeDefined();
    expect(fixtureRow!.referrerName).toBeNull();
  });

  it("orders members newest-registered-first", async () => {
    const admin = createAdminClient();
    const { data: older, error: olderError } = await admin
      .from("members")
      .insert({
        club_id: data.clubA.clubId,
        code: "MEM-TEST-0003",
        first: "Older",
        last: "Member",
        type: "Trial",
        status: "active",
        joined_at: new Date(Date.now() - 60000).toISOString(),
      })
      .select()
      .single();
    if (olderError) throw olderError;
    cleanupMemberIds.push(older.id);

    const { data: newer, error: newerError } = await admin
      .from("members")
      .insert({
        club_id: data.clubA.clubId,
        code: "MEM-TEST-0004",
        first: "Newer",
        last: "Member",
        type: "Trial",
        status: "active",
        joined_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (newerError) throw newerError;
    cleanupMemberIds.push(newer.id);

    const members = await listMembers(clubAClient, data.clubA.clubId);
    const olderIndex = members.findIndex((m) => m.id === older.id);
    const newerIndex = members.findIndex((m) => m.id === newer.id);
    expect(newerIndex).toBeLessThan(olderIndex);
  });
});
