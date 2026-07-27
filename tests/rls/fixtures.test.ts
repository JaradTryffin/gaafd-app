import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin";
import { seedTenants, cleanupTenants, type SeededData } from "./fixtures";

let data: SeededData;

beforeAll(async () => {
  data = await seedTenants();
}, 30000);

afterAll(async () => {
  if (data) {
    await cleanupTenants(data);
  }
}, 30000);

describe("seedTenants", () => {
  it("creates two distinct clubs with all child rows", () => {
    expect(data.clubA.clubId).toBeTruthy();
    expect(data.clubB.clubId).toBeTruthy();
    expect(data.clubA.clubId).not.toBe(data.clubB.clubId);
    for (const club of [data.clubA, data.clubB]) {
      expect(club.adminUserId).toBeTruthy();
      expect(club.memberId).toBeTruthy();
      expect(club.productId).toBeTruthy();
      expect(club.inventoryMoveId).toBeTruthy();
      expect(club.donationId).toBeTruthy();
      expect(club.contractTemplateId).toBeTruthy();
      expect(club.signedContractId).toBeTruthy();
    }
  });

  it("creates a platform user with no club membership", async () => {
    const admin = createAdminClient();
    const { data: rows } = await admin
      .from("club_users")
      .select("id")
      .eq("user_id", data.platformUserId);
    expect(rows).toEqual([]);
  });

  it("uploads a real signature object to Storage", async () => {
    const admin = createAdminClient();
    const { data: file, error } = await admin.storage
      .from("signatures")
      .download(data.clubA.signaturePath);
    expect(error).toBeNull();
    expect(file).not.toBeNull();
  });
});
