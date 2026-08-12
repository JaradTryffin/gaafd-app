import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { seedTenants, cleanupTenants, signInAs, type SeededData, type SeededClub } from "./fixtures";

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

const tenantTables = [
  "members",
  "products",
  "inventory_moves",
  "donations",
  "contract_templates",
  "signed_contracts",
] as const;

// Tables with full SELECT/INSERT/UPDATE/DELETE tenant-scoped policies.
// inventory_moves and signed_contracts are deliberately excluded — they're
// append-only (SELECT + INSERT only), so UPDATE/DELETE isolation doesn't
// apply to them (there's no policy permitting either operation to anyone).
const fullCrudTables = ["members", "products", "donations", "contract_templates"] as const;

type Direction = {
  label: string;
  client: () => SupabaseClient;
  own: () => SeededClub;
  other: () => SeededClub;
};

// Both directions of cross-club access are tested symmetrically — proving
// "Club A can't touch Club B" alone would leave the reverse case unproven.
const directions: Direction[] = [
  {
    label: "Club A -> Club B",
    client: () => clubAClient,
    own: () => data.clubA,
    other: () => data.clubB,
  },
  {
    label: "Club B -> Club A",
    client: () => clubBClient,
    own: () => data.clubB,
    other: () => data.clubA,
  },
];

describe("sanity: each admin can read their own club's data", () => {
  for (const dir of directions) {
    for (const table of tenantTables) {
      it(`${dir.label.split(" -> ")[0]} admin can select own ${table} row`, async () => {
        const { data: rows, error } = await dir
          .client()
          .from(table)
          .select("*")
          .eq("club_id", dir.own().clubId);
        expect(error).toBeNull();
        expect(rows?.length).toBeGreaterThan(0);
      });
    }
  }
});

describe("cross-club isolation: cannot read the other club's tenant tables", () => {
  for (const dir of directions) {
    for (const table of tenantTables) {
      it(`${dir.label}: select on ${table} scoped to the other club returns no rows`, async () => {
        const { data: rows, error } = await dir
          .client()
          .from(table)
          .select("*")
          .eq("club_id", dir.other().clubId);
        expect(error).toBeNull();
        expect(rows).toEqual([]);
      });
    }
  }
});

describe("cross-club isolation: cannot write into the other club's tenant tables", () => {
  for (const dir of directions) {
    for (const table of fullCrudTables) {
      if (table !== "contract_templates") {
        it(`${dir.label}: insert into ${table} scoped to the other club is rejected`, async () => {
          const row: Record<string, unknown> = { club_id: dir.other().clubId };
          if (table === "members") {
            Object.assign(row, {
              code: "HACK-0001",
              first: "Intruder",
              last: "Test",
              type: "Full member",
            });
          } else if (table === "products") {
            Object.assign(row, {
              name: "Intruder Product",
              category_id: dir.other().categoryId,
              unit: "each",
              token_price: 1,
              sell_price: 1,
            });
          } else if (table === "donations") {
            Object.assign(row, {
              member_id: dir.other().memberId,
              amount_rand: 1,
              method: "Cash",
              tokens_credited: 1,
            });
          }
          const { error } = await dir.client().from(table).insert(row);
          expect(error).not.toBeNull();
        });
      }
      // contract_templates.club_id is UNIQUE, and every seeded club already
      // has one — an insert scoped to the other club would fail on that
      // unique constraint regardless of RLS, which would prove nothing
      // about the RLS policy specifically. UPDATE/DELETE below (matched by
      // an existing row id) aren't affected by that constraint and do
      // meaningfully test this table's RLS.

      it(`${dir.label}: update on the other club's ${table} row (matched by id) affects nothing`, async () => {
        const idValue =
          table === "contract_templates"
            ? dir.other().contractTemplateId
            : table === "products"
              ? dir.other().productId
              : table === "donations"
                ? dir.other().donationId
                : dir.other().memberId;
        const patch =
          table === "members"
            ? { token_balance: 999999 }
            : table === "products"
              ? { name: "Hacked" }
              : table === "donations"
                ? { amount_rand: 999999 }
                : { title: "Hacked" };
        const { data: rows, error } = await dir
          .client()
          .from(table)
          .update(patch)
          .eq("id", idValue)
          .select();
        expect(error).toBeNull();
        expect(rows).toEqual([]);
      });

      it(`${dir.label}: delete on the other club's ${table} row (matched by id) affects nothing`, async () => {
        const idValue =
          table === "contract_templates"
            ? dir.other().contractTemplateId
            : table === "products"
              ? dir.other().productId
              : table === "donations"
                ? dir.other().donationId
                : dir.other().memberId;
        const { data: rows, error } = await dir
          .client()
          .from(table)
          .delete()
          .eq("id", idValue)
          .select();
        expect(error).toBeNull();
        expect(rows).toEqual([]);
      });
    }
  }

  it("Club B's member still exists, unchanged, after Club A's attempted update/delete", async () => {
    const admin = createAdminClient();
    const { data: row } = await admin
      .from("members")
      .select("id, token_balance")
      .eq("id", data.clubB.memberId)
      .single();
    expect(row?.id).toBe(data.clubB.memberId);
    expect(row?.token_balance).toBe(100);
  });

  it("Club A's member still exists, unchanged, after Club B's attempted update/delete", async () => {
    const admin = createAdminClient();
    const { data: row } = await admin
      .from("members")
      .select("id, token_balance")
      .eq("id", data.clubA.memberId)
      .single();
    expect(row?.id).toBe(data.clubA.memberId);
    expect(row?.token_balance).toBe(100);
  });
});

describe("cross-club isolation: cannot insert into the other club's append-only tables", () => {
  for (const dir of directions) {
    it(`${dir.label}: insert into inventory_moves scoped to the other club is rejected`, async () => {
      const { error } = await dir.client().from("inventory_moves").insert({
        club_id: dir.other().clubId,
        product_id: dir.other().productId,
        type: "ADJUSTMENT",
        qty: 1,
      });
      expect(error).not.toBeNull();
    });

    it(`${dir.label}: insert into signed_contracts scoped to the other club is rejected`, async () => {
      const { error } = await dir.client().from("signed_contracts").insert({
        club_id: dir.other().clubId,
        member_id: dir.other().memberId,
        template_version: 1,
        contract_snapshot: { title: "Intruder" },
        consent: true,
        signature_url: "intruder.png",
      });
      expect(error).not.toBeNull();
    });
  }
});

describe("append-only enforcement: not even the owning club can mutate audit tables", () => {
  // With RLS enabled and zero policies defined for a given command, that
  // command is denied for everyone. Depending on how PostgREST surfaces
  // that (a thrown error, vs. a USING-style silent zero-row match like the
  // cross-club UPDATE/DELETE tests above), the denial could show up either
  // way — so these assert the property that actually matters (no row came
  // back) rather than guessing which representation Postgres chooses. The
  // "still unchanged" check below is the final, unambiguous proof.
  it("Club A cannot update its own inventory_moves row", async () => {
    const { data: rows } = await clubAClient
      .from("inventory_moves")
      .update({ qty: 999 })
      .eq("id", data.clubA.inventoryMoveId)
      .select();
    expect(rows ?? []).toEqual([]);
  });

  it("Club A cannot delete its own inventory_moves row", async () => {
    const { data: rows } = await clubAClient
      .from("inventory_moves")
      .delete()
      .eq("id", data.clubA.inventoryMoveId)
      .select();
    expect(rows ?? []).toEqual([]);
  });

  it("Club A cannot update its own signed_contracts row", async () => {
    const { data: rows } = await clubAClient
      .from("signed_contracts")
      .update({ consent: false })
      .eq("id", data.clubA.signedContractId)
      .select();
    expect(rows ?? []).toEqual([]);
  });

  it("Club A cannot delete its own signed_contracts row", async () => {
    const { data: rows } = await clubAClient
      .from("signed_contracts")
      .delete()
      .eq("id", data.clubA.signedContractId)
      .select();
    expect(rows ?? []).toEqual([]);
  });

  it("Club A's inventory_moves and signed_contracts rows are still unchanged", async () => {
    const admin = createAdminClient();
    const { data: move } = await admin
      .from("inventory_moves")
      .select("id, qty")
      .eq("id", data.clubA.inventoryMoveId)
      .single();
    expect(move?.qty).toBe(100);

    const { data: contract } = await admin
      .from("signed_contracts")
      .select("id, consent")
      .eq("id", data.clubA.signedContractId)
      .single();
    expect(contract?.consent).toBe(true);
  });
});

describe("cross-club isolation: guessed/enumerated ids", () => {
  for (const dir of directions) {
    it(`${dir.label}: cannot fetch the other club's signed contract by guessing its id`, async () => {
      const { data: rows, error } = await dir
        .client()
        .from("signed_contracts")
        .select("*")
        .eq("id", dir.other().signedContractId);
      expect(error).toBeNull();
      expect(rows).toEqual([]);
    });

    it(`${dir.label}: cannot fetch the other club's product by guessing its id`, async () => {
      const { data: rows, error } = await dir
        .client()
        .from("products")
        .select("*")
        .eq("id", dir.other().productId);
      expect(error).toBeNull();
      expect(rows).toEqual([]);
    });

    it(`${dir.label}: cannot read the other club's signature file from Storage`, async () => {
      const { data: fileData, error } = await dir
        .client()
        .storage.from("signatures")
        .download(dir.other().signaturePath);
      expect(fileData).toBeNull();
      expect(error).not.toBeNull();
    });

    it(`${dir.label}: cannot upload into the other club's signature path`, async () => {
      const { error } = await dir
        .client()
        .storage.from("signatures")
        .upload(`${dir.other().clubId}/${dir.other().memberId}/intruder.png`, Buffer.from("x"));
      expect(error).not.toBeNull();
    });
  }
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
