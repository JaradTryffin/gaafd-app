import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedTenants, cleanupTenants, signInAs, type SeededData } from "../rls/fixtures";
import { resolveClubAccess, resolvePlatformAccess, listUserClubs } from "@/lib/auth/club-access";
import { createAdminClient } from "@/lib/supabase/admin";

let data: SeededData;
let clubAClient: SupabaseClient;
let clubBClient: SupabaseClient;
let platformClient: SupabaseClient;

beforeAll(async () => {
  data = await seedTenants();
  clubAClient = await signInAs(data.clubA.adminEmail, data.clubA.adminPassword);
  clubBClient = await signInAs(data.clubB.adminEmail, data.clubB.adminPassword);
  platformClient = await signInAs(data.platformEmail, data.platformPassword);
}, 30000);

afterAll(async () => {
  if (data) {
    await cleanupTenants(data);
  }
}, 30000);

describe("resolveClubAccess", () => {
  it("returns access with role for a member's own club", async () => {
    const access = await resolveClubAccess(clubAClient, data.clubA.slug);
    expect(access?.clubId).toBe(data.clubA.clubId);
    expect(access?.role).toBe("admin");
  });

  it("returns null for a club the caller doesn't belong to", async () => {
    const access = await resolveClubAccess(clubAClient, data.clubB.slug);
    expect(access).toBeNull();
  });

  it("club B's admin gets access to club B, not club A (both directions checked)", async () => {
    const ownAccess = await resolveClubAccess(clubBClient, data.clubB.slug);
    expect(ownAccess?.clubId).toBe(data.clubB.clubId);

    const otherAccess = await resolveClubAccess(clubBClient, data.clubA.slug);
    expect(otherAccess).toBeNull();
  });

  it("returns null for a platform-only caller (no club membership)", async () => {
    const access = await resolveClubAccess(platformClient, data.clubA.slug);
    expect(access).toBeNull();
  });

  it("returns null for a nonexistent slug", async () => {
    const access = await resolveClubAccess(clubAClient, "does-not-exist-slug");
    expect(access).toBeNull();
  });
});

describe("resolvePlatformAccess", () => {
  it("returns true for the platform user", async () => {
    expect(await resolvePlatformAccess(platformClient)).toBe(true);
  });

  it("returns false for a club admin", async () => {
    expect(await resolvePlatformAccess(clubAClient)).toBe(false);
  });
});

describe("listUserClubs", () => {
  it("returns exactly the caller's own club", async () => {
    const clubs = await listUserClubs(clubAClient);
    expect(clubs.map((c) => c.clubId)).toEqual([data.clubA.clubId]);
  });

  it("returns every club a multi-club owner belongs to", async () => {
    const admin = createAdminClient();
    const { error } = await admin.from("club_users").insert({
      club_id: data.clubB.clubId,
      user_id: data.clubA.adminUserId,
      role: "admin",
    });
    if (error) throw error;

    try {
      const clubs = await listUserClubs(clubAClient);
      expect(clubs.map((c) => c.clubId).sort()).toEqual(
        [data.clubA.clubId, data.clubB.clubId].sort(),
      );
    } finally {
      await admin
        .from("club_users")
        .delete()
        .eq("club_id", data.clubB.clubId)
        .eq("user_id", data.clubA.adminUserId);
    }
  });

  it("returns an empty array for a platform-only caller", async () => {
    const clubs = await listUserClubs(platformClient);
    expect(clubs).toEqual([]);
  });
});
