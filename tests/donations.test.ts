import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedTenants, cleanupTenants, signInAs, type SeededData } from "./rls/fixtures";
import { createAdminClient } from "@/lib/supabase/admin";
import { getTodaysDonations, recordDonation } from "@/lib/donations";

let data: SeededData;
let clubAClient: SupabaseClient;
let clubBClient: SupabaseClient;
const cleanupDonationIds: string[] = [];

beforeAll(async () => {
  data = await seedTenants();
  clubAClient = await signInAs(data.clubA.adminEmail, data.clubA.adminPassword);
  clubBClient = await signInAs(data.clubB.adminEmail, data.clubB.adminPassword);
}, 30000);

afterAll(async () => {
  const admin = createAdminClient();
  if (cleanupDonationIds.length > 0) {
    await admin.from("donations").delete().in("id", cleanupDonationIds);
  }
  if (data) {
    await cleanupTenants(data);
  }
}, 30000);

describe("recordDonation", () => {
  it("inserts the donation and credits the member's token balance atomically", async () => {
    const admin = createAdminClient();
    const { data: before } = await admin
      .from("members")
      .select("token_balance")
      .eq("id", data.clubA.memberId)
      .single();

    const donation = await recordDonation(clubAClient, data.clubA.clubId, {
      memberId: data.clubA.memberId,
      amountRand: 250,
      method: "Cash",
    });
    cleanupDonationIds.push(donation.id);

    expect(donation.tokensCredited).toBe(250);
    expect(donation.amountRand).toBe(250);
    expect(donation.method).toBe("Cash");

    const { data: after } = await admin
      .from("members")
      .select("token_balance")
      .eq("id", data.clubA.memberId)
      .single();
    expect(after!.token_balance).toBe(before!.token_balance + 250);
  });

  it("rejects a non-positive amount", async () => {
    await expect(
      recordDonation(clubAClient, data.clubA.clubId, {
        memberId: data.clubA.memberId,
        amountRand: 0,
        method: "Cash",
      }),
    ).rejects.toThrow();
  });

  it("rejects a member belonging to a different club", async () => {
    await expect(
      recordDonation(clubAClient, data.clubA.clubId, {
        memberId: data.clubB.memberId,
        amountRand: 100,
        method: "Card",
      }),
    ).rejects.toThrow("Member not found in this club");
  });
});

describe("getTodaysDonations", () => {
  it("returns only the caller's club's donations, not club B's", async () => {
    const donations = await getTodaysDonations(clubAClient, data.clubA.clubId);
    const ids = donations.map((d) => d.id);
    expect(ids).not.toContain(data.clubB.donationId);
  });

  it("includes the fixture's seeded donation (created now, inside today's window)", async () => {
    const donations = await getTodaysDonations(clubAClient, data.clubA.clubId);
    const fixtureDonation = donations.find((d) => d.id === data.clubA.donationId);
    expect(fixtureDonation).toBeDefined();
    expect(fixtureDonation!.amountRand).toBe(300);
    expect(fixtureDonation!.tokensCredited).toBe(300);
    expect(fixtureDonation!.memberName).toBe("Test Member");
  });

  it("excludes a donation backdated outside today's SAST window", async () => {
    const admin = createAdminClient();
    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    const { data: backdated, error } = await admin
      .from("donations")
      .insert({
        club_id: data.clubA.clubId,
        member_id: data.clubA.memberId,
        amount_rand: 50,
        method: "EFT",
        tokens_credited: 50,
        created_at: yesterday,
      })
      .select()
      .single();
    if (error) throw error;
    cleanupDonationIds.push(backdated.id);

    const donations = await getTodaysDonations(clubAClient, data.clubA.clubId);
    expect(donations.map((d) => d.id)).not.toContain(backdated.id);
  });
});
