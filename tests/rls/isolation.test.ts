import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { seedTenants, cleanupTenants, signInAs, type SeededData } from "./fixtures";

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
  await cleanupTenants(data);
}, 30000);

const tenantTables = [
  "members",
  "products",
  "inventory_moves",
  "donations",
  "contract_templates",
  "signed_contracts",
] as const;

describe("sanity: each admin can read their own club's data", () => {
  for (const table of tenantTables) {
    it(`Club A admin can select own ${table} row`, async () => {
      const { data: rows, error } = await clubAClient
        .from(table)
        .select("*")
        .eq("club_id", data.clubA.clubId);
      expect(error).toBeNull();
      expect(rows?.length).toBeGreaterThan(0);
    });
  }
});

describe("cross-club isolation: Club A cannot read Club B's tenant tables", () => {
  for (const table of tenantTables) {
    it(`select on ${table} scoped to Club B returns no rows`, async () => {
      const { data: rows, error } = await clubAClient
        .from(table)
        .select("*")
        .eq("club_id", data.clubB.clubId);
      expect(error).toBeNull();
      expect(rows).toEqual([]);
    });
  }
});

describe("cross-club isolation: Club A cannot write into Club B's tenant tables", () => {
  it("insert into Club B's members is rejected", async () => {
    const { error } = await clubAClient.from("members").insert({
      club_id: data.clubB.clubId,
      code: "HACK-0001",
      first: "Intruder",
      last: "Test",
      type: "Full member",
    });
    expect(error).not.toBeNull();
  });

  it("update on Club B's member row (matched by id) affects nothing", async () => {
    const { data: rows, error } = await clubAClient
      .from("members")
      .update({ token_balance: 999999 })
      .eq("id", data.clubB.memberId)
      .select();
    expect(error).toBeNull();
    expect(rows).toEqual([]);
  });

  it("delete on Club B's member row (matched by id) affects nothing", async () => {
    const { data: rows, error } = await clubAClient
      .from("members")
      .delete()
      .eq("id", data.clubB.memberId)
      .select();
    expect(error).toBeNull();
    expect(rows).toEqual([]);
  });

  it("Club B's member still exists after the attempted update/delete", async () => {
    const admin = createAdminClient();
    const { data: row } = await admin
      .from("members")
      .select("id, token_balance")
      .eq("id", data.clubB.memberId)
      .single();
    expect(row?.id).toBe(data.clubB.memberId);
    expect(row?.token_balance).toBe(100);
  });
});

describe("cross-club isolation: guessed/enumerated ids", () => {
  it("Club A cannot fetch Club B's signed contract by guessing its id", async () => {
    const { data: rows, error } = await clubAClient
      .from("signed_contracts")
      .select("*")
      .eq("id", data.clubB.signedContractId);
    expect(error).toBeNull();
    expect(rows).toEqual([]);
  });

  it("Club A cannot read Club B's signature file from Storage", async () => {
    const { data: fileData, error } = await clubAClient.storage
      .from("signatures")
      .download(data.clubB.signaturePath);
    expect(fileData).toBeNull();
    expect(error).not.toBeNull();
  });

  it("Club A cannot upload into Club B's signature path", async () => {
    const { error } = await clubAClient.storage
      .from("signatures")
      .upload(`${data.clubB.clubId}/${data.clubB.memberId}/intruder.png`, Buffer.from("x"));
    expect(error).not.toBeNull();
  });
});

describe("platform role: aggregate-only, no row-level access to operational data", () => {
  it("SELECT on clubs returns both seeded clubs", async () => {
    const { data: rows, error } = await platformClient
      .from("clubs")
      .select("id")
      .in("id", [data.clubA.clubId, data.clubB.clubId]);
    expect(error).toBeNull();
    expect(rows?.map((r) => r.id).sort()).toEqual(
      [data.clubA.clubId, data.clubB.clubId].sort(),
    );
  });

  it("platform_club_stats returns correct member counts for both clubs", async () => {
    const { data: rows, error } = await platformClient.rpc("platform_club_stats");
    expect(error).toBeNull();
    const statA = rows?.find(
      (r: { club_id: string; member_count: number }) => r.club_id === data.clubA.clubId,
    );
    const statB = rows?.find(
      (r: { club_id: string; member_count: number }) => r.club_id === data.clubB.clubId,
    );
    expect(statA?.member_count).toBe(1);
    expect(statB?.member_count).toBe(1);
  });

  for (const table of tenantTables) {
    it(`platform role gets no row-level SELECT on ${table}`, async () => {
      const { data: rows, error } = await platformClient
        .from(table)
        .select("*")
        .in("club_id", [data.clubA.clubId, data.clubB.clubId]);
      expect(error).toBeNull();
      expect(rows).toEqual([]);
    });
  }

  it("platform role gets no access to signature files", async () => {
    const { data: fileData, error } = await platformClient.storage
      .from("signatures")
      .download(data.clubA.signaturePath);
    expect(fileData).toBeNull();
    expect(error).not.toBeNull();
  });
});

describe("plain club user: no platform-only access", () => {
  it("platform_club_stats returns nothing for a non-platform user", async () => {
    const { data: rows, error } = await clubAClient.rpc("platform_club_stats");
    expect(error).toBeNull();
    expect(rows).toEqual([]);
  });

  it("clubs SELECT only returns the caller's own club, not the other club", async () => {
    const { data: rows, error } = await clubAClient
      .from("clubs")
      .select("id")
      .in("id", [data.clubA.clubId, data.clubB.clubId]);
    expect(error).toBeNull();
    expect(rows?.map((r) => r.id)).toEqual([data.clubA.clubId]);
  });
});
