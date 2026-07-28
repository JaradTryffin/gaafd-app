import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedTenants, cleanupTenants, signInAs, type SeededData } from "./rls/fixtures";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getOrCreateContractTemplate,
  saveContractTemplate,
  resetContractTemplate,
} from "@/lib/contracts";

let data: SeededData;
let clubAClient: SupabaseClient;

beforeAll(async () => {
  data = await seedTenants();
  clubAClient = await signInAs(data.clubA.adminEmail, data.clubA.adminPassword);
}, 30000);

afterAll(async () => {
  if (data) {
    await cleanupTenants(data);
  }
}, 30000);

describe("getOrCreateContractTemplate", () => {
  it("seeds a real default template for a club with no existing row", async () => {
    // tests/rls/fixtures.ts's seedClub() already inserts a minimal test
    // template for every club it creates (shared infrastructure other
    // test files rely on) — so clubA/clubB from seedTenants() are NOT
    // template-less. The only way to genuinely exercise the "no row yet"
    // seeding path is a throwaway club created here, not reused from
    // seedTenants.
    const admin = createAdminClient();
    const suffix = crypto.randomUUID().slice(0, 8);
    const { data: club, error } = await admin
      .from("clubs")
      .insert({
        slug: `contracts-test-${suffix}`,
        name: `Contracts Test Club ${suffix}`,
        initials: "CT",
        plan: "Trial",
        region: "Test Region",
        accent_color: "#3f7a4e",
        status: "active",
      })
      .select()
      .single();
    if (error) throw error;

    try {
      const template = await getOrCreateContractTemplate(admin, club.id, "Contracts Test Club");
      expect(template.title).toContain("Contracts Test Club");
      expect(template.clauses).toHaveLength(9);
      expect(template.version).toBe(1);
    } finally {
      await admin.from("clubs").delete().eq("id", club.id);
    }
  });

  it("returns the same template on a second call, not a duplicate", async () => {
    const first = await getOrCreateContractTemplate(clubAClient, data.clubA.clubId, "Test Club A");
    const second = await getOrCreateContractTemplate(clubAClient, data.clubA.clubId, "Test Club A");
    expect(second.id).toBe(first.id);
    expect(second.version).toBe(first.version);
  });
});

describe("saveContractTemplate", () => {
  it("updates content and increments the version", async () => {
    const before = await getOrCreateContractTemplate(clubAClient, data.clubA.clubId, "Test Club A");
    const updated = await saveContractTemplate(clubAClient, data.clubA.clubId, {
      title: "Updated Title",
      subtitle: "Updated subtitle",
      consent: "Updated consent",
      clauses: [{ heading: "Only Clause", body: "Only body" }],
    });
    expect(updated.title).toBe("Updated Title");
    expect(updated.clauses).toHaveLength(1);
    expect(updated.version).toBe(before.version + 1);
  });
});

describe("resetContractTemplate", () => {
  it("restores the default text and still increments the version", async () => {
    await saveContractTemplate(clubAClient, data.clubA.clubId, {
      title: "Something Else Entirely",
      subtitle: "x",
      consent: "x",
      clauses: [{ heading: "x", body: "x" }],
    });
    const before = await getOrCreateContractTemplate(clubAClient, data.clubA.clubId, "Test Club A");

    const reset = await resetContractTemplate(clubAClient, data.clubA.clubId, "Test Club A");
    expect(reset.title).toBe("Test Club A — Member Agreement");
    expect(reset.clauses).toHaveLength(9);
    expect(reset.version).toBe(before.version + 1);
  });
});
