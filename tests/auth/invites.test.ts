import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { seedTenants, cleanupTenants, signInAs, type SeededData } from "../rls/fixtures";
import { inviteStaffToClub, createClubAndInviteAdmin } from "@/lib/invites";

const PASSWORD = "Test-Password-123!";

let data: SeededData;
let clubAClient: SupabaseClient;
let clubBClient: SupabaseClient;
let platformClient: SupabaseClient;
const cleanupUserIds: string[] = [];
const cleanupClubIds: string[] = [];

beforeAll(async () => {
  data = await seedTenants();
  clubAClient = await signInAs(data.clubA.adminEmail, data.clubA.adminPassword);
  clubBClient = await signInAs(data.clubB.adminEmail, data.clubB.adminPassword);
  platformClient = await signInAs(data.platformEmail, data.platformPassword);
}, 30000);

afterAll(async () => {
  const admin = createAdminClient();
  for (const userId of cleanupUserIds) {
    await admin.auth.admin.deleteUser(userId);
  }
  for (const clubId of cleanupClubIds) {
    await admin.from("clubs").delete().eq("id", clubId);
  }
  if (data) {
    await cleanupTenants(data);
  }
}, 30000);

describe("inviteStaffToClub", () => {
  it("club admin can invite staff into their own club", async () => {
    // Supabase's built-in email provider validates deliverability and
    // rejects RFC-2606 reserved domains like example.test/example.com
    // outright — mailinator.com is a real, publicly-deliverable disposable
    // inbox domain, so this actually exercises the email-send path rather
    // than failing before it (unlike admin.createUser, used elsewhere in
    // fixtures.ts, which never sends mail and doesn't hit this validation).
    const email = `gaafd-rls-invite-${crypto.randomUUID().slice(0, 8)}@mailinator.com`;
    const { userId } = await inviteStaffToClub(clubAClient, data.clubA.clubId, email);
    cleanupUserIds.push(userId);

    const admin = createAdminClient();
    const { data: membership } = await admin
      .from("club_users")
      .select("role")
      .eq("club_id", data.clubA.clubId)
      .eq("user_id", userId)
      .single();
    expect(membership?.role).toBe("staff");
  });

  it("club admin cannot invite staff into a different club", async () => {
    const email = `rls-invite-${crypto.randomUUID().slice(0, 8)}@example.test`;
    await expect(inviteStaffToClub(clubAClient, data.clubB.clubId, email)).rejects.toThrow();
  });

  it("a staff-role caller cannot invite staff at all", async () => {
    const staffEmail = `rls-staffcaller-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const admin = createAdminClient();
    const { data: staffAuth, error: staffAuthError } = await admin.auth.admin.createUser({
      email: staffEmail,
      password: PASSWORD,
      email_confirm: true,
    });
    if (staffAuthError) throw staffAuthError;
    cleanupUserIds.push(staffAuth.user.id);

    const { error: staffInsertError } = await admin.from("club_users").insert({
      club_id: data.clubA.clubId,
      user_id: staffAuth.user.id,
      role: "staff",
    });
    if (staffInsertError) throw staffInsertError;

    const staffClient = await signInAs(staffEmail, PASSWORD);
    const email = `rls-invite-${crypto.randomUUID().slice(0, 8)}@example.test`;
    await expect(inviteStaffToClub(staffClient, data.clubA.clubId, email)).rejects.toThrow();
  });

  it("a platform-only caller cannot invite staff via this path", async () => {
    const email = `rls-invite-${crypto.randomUUID().slice(0, 8)}@example.test`;
    await expect(inviteStaffToClub(platformClient, data.clubA.clubId, email)).rejects.toThrow();
  });
});

describe("createClubAndInviteAdmin", () => {
  it("platform user can onboard a new club with its first admin", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    // Same deliverability reasoning as the invite-staff test above.
    const adminEmail = `gaafd-rls-newclub-admin-${suffix}@mailinator.com`;
    const { clubId, adminUserId } = await createClubAndInviteAdmin(platformClient, {
      slug: `rls-newclub-${suffix}`,
      name: `RLS New Club ${suffix}`,
      initials: "NC",
      plan: "Trial",
      region: "Test Region",
      accentColor: "#3f7a4e",
      adminEmail,
    });
    cleanupClubIds.push(clubId);
    cleanupUserIds.push(adminUserId);

    const admin = createAdminClient();
    const { data: membership } = await admin
      .from("club_users")
      .select("role")
      .eq("club_id", clubId)
      .eq("user_id", adminUserId)
      .single();
    expect(membership?.role).toBe("admin");
  });

  it("a club admin (non-platform) cannot onboard a new club", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    await expect(
      createClubAndInviteAdmin(clubAClient, {
        slug: `rls-rejected-${suffix}`,
        name: "Should Not Exist",
        initials: "XX",
        plan: "Trial",
        region: "Test Region",
        accentColor: "#000000",
        adminEmail: `rls-rejected-${suffix}@example.test`,
      }),
    ).rejects.toThrow();
  });
});
