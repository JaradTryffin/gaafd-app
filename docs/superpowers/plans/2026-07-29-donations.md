# Donations Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `/[clubSlug]/donations` — record a donation (member, amount, method), atomically credit the member's token balance, and show today's donations, currently unbuilt (sidebar's "Donations" link 404s today).

**Architecture:** A Postgres function (`record_donation`) doing the insert + token-credit atomically in one transaction — this project's first RPC/stored-procedure use — then a data layer (`src/lib/donations.ts`) calling it, then a single UI task. This is the first screen that actually writes to `members.token_balance` (every prior screen only read it).

**Tech Stack:** Next.js App Router, TypeScript, Supabase JS client (including `.rpc()`), Vitest.

## Global Constraints

- Reuse `src/lib/supabase/server.ts`, `src/lib/auth/club-access.ts`'s `resolveClubAccess`, `src/lib/page-header-context.tsx`'s `usePageHeader`, `src/lib/toast-context.tsx`'s `useToast`, `src/lib/members.ts`'s `listMembers`, `src/lib/format.ts`'s `sastDayRange` exactly as they exist — do not modify any of them.
- No PostgREST relation embedding anywhere.
- No shadcn/`@base-ui/react` components — hand-rolled Tailwind markup, matching every prior screen.
- Every labeled form field needs `htmlFor`/`id` pairing.
- Migration files follow the existing `YYYYMMDDHHMMSS_description.sql` naming, applied via `supabase db push --linked` against the live linked project (ref `inlseklfbptgjketdnpe`).
- pnpm exclusively, Node via `.nvmrc` (run `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use` before any command).
- Commit messages plain, imperative. Work on branch `master` directly (standing consent from all prior phases).
- `tests/rls/fixtures.ts`'s `SeededClub` has `memberId` and `donationId` fields (confirmed by direct read). `seedClub()` seeds the fixture member with `token_balance: 100` and one donation (R300, `Cash`, 300 tokens credited, no explicit `created_at` — defaults to `now()`, so it falls inside today's SAST window). Task 2's tests build on this non-empty baseline.

---

### Task 1: Migration — `record_donation` Postgres function

**Files:**
- Create: `supabase/migrations/20260729170000_record_donation_function.sql`

**Interfaces:**
- Produces: the `record_donation(p_club_id uuid, p_member_id uuid, p_amount_rand numeric, p_method text) returns donations` function — consumed by Task 2 via `supabase.rpc("record_donation", {...})`.

No application code in this task — pure schema, verified against the live project directly.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260729170000_record_donation_function.sql`:

```sql
create or replace function record_donation(
  p_club_id uuid,
  p_member_id uuid,
  p_amount_rand numeric,
  p_method text
)
returns donations
language plpgsql
security invoker
as $$
declare
  v_row donations;
  v_tokens integer;
begin
  if p_amount_rand is null or p_amount_rand <= 0 then
    raise exception 'Donation amount must be positive';
  end if;

  -- Defense-in-depth, matching this project's established pattern
  -- (signContract, createMovement): the donations INSERT policy only
  -- checks the new row's own club_id, never cross-validates that
  -- member_id belongs to that same club. Without this check, a
  -- mismatched (club_id, member_id) pair would silently insert the
  -- donation while the token-credit UPDATE below matches zero rows
  -- (its WHERE clause requires both id and club_id) -- donation
  -- recorded, no tokens credited, no error raised.
  if not exists (select 1 from members where id = p_member_id and club_id = p_club_id) then
    raise exception 'Member not found in this club';
  end if;

  v_tokens := round(p_amount_rand)::integer;

  insert into donations (club_id, member_id, amount_rand, method, tokens_credited)
  values (p_club_id, p_member_id, p_amount_rand, p_method, v_tokens)
  returning * into v_row;

  update members
  set token_balance = token_balance + v_tokens
  where id = p_member_id and club_id = p_club_id;

  return v_row;
end;
$$;
```

- [ ] **Step 2: Apply the migration**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use && supabase db push --linked`
Expected: lists the new migration, applies it, ends with `Finished supabase db push.`

- [ ] **Step 3: Verify nothing is left pending**

Run: `supabase db push --linked --dry-run`
Expected: no pending migrations listed.

- [ ] **Step 4: Verify the function exists**

```sql
select proname from pg_proc where proname = 'record_donation';
```
Expected: one row.

- [ ] **Step 5: Verify it's genuinely callable end-to-end**

Using the service-role admin client (matching `tests/rls/fixtures.ts`'s pattern), create a throwaway club + member for this verification only (NOT the real `demo` club), call:

```ts
const { data, error } = await admin.rpc("record_donation", {
  p_club_id: throwawayClubId,
  p_member_id: throwawayMemberId,
  p_amount_rand: 100,
  p_method: "Cash",
});
```

Expected: `error` is `null`, `data` is a single `donations` row object (not an array) with `tokens_credited: 100`. Then query the member's `token_balance` directly and confirm it increased by exactly 100 from whatever it started at. Delete the throwaway club afterward (cascades to the member/donation).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260729170000_record_donation_function.sql
git commit -m "Add record_donation Postgres function for atomic donation + token credit"
```

---

### Task 2: Donations data layer

**Files:**
- Create: `src/lib/donations.ts`
- Test: `tests/donations.test.ts`

**Interfaces:**
- Consumes: Task 1's `record_donation` function.
- Produces: `type DonationMethod`, `type Donation`, `type RecordDonationInput`, `getTodaysDonations(supabase, clubId): Promise<Donation[]>`, `recordDonation(supabase, clubId, input): Promise<Donation>` — all consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

Create `tests/donations.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/donations.test.ts`
Expected: FAIL — `Cannot find module '@/lib/donations'`. (Requires Task 1's migration to already be live.)

- [ ] **Step 3: Implement**

Create `src/lib/donations.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { sastDayRange } from "@/lib/format";

export type DonationMethod = "Cash" | "Card" | "EFT";

export type Donation = {
  id: string;
  memberId: string;
  memberName: string;
  amountRand: number;
  method: DonationMethod;
  tokensCredited: number;
  createdAt: string;
};

type DonationRow = {
  id: string;
  member_id: string;
  amount_rand: number;
  method: DonationMethod;
  tokens_credited: number;
  created_at: string;
};

export async function getTodaysDonations(supabase: SupabaseClient, clubId: string): Promise<Donation[]> {
  const today = sastDayRange(0);
  const { data: rows, error } = await supabase
    .from("donations")
    .select("id, member_id, amount_rand, method, tokens_credited, created_at")
    .eq("club_id", clubId)
    .gte("created_at", today.start)
    .lt("created_at", today.end)
    .order("created_at", { ascending: false });
  if (error) throw error;

  const list = rows ?? [];
  if (list.length === 0) return [];

  const memberIds = [...new Set(list.map((r) => r.member_id as string))];
  const { data: members, error: membersError } = await supabase
    .from("members")
    .select("id, first, last")
    .in("id", memberIds);
  if (membersError) throw membersError;
  const nameById = new Map((members ?? []).map((m) => [m.id as string, `${m.first} ${m.last}`]));

  return list.map((row) => {
    const r = row as DonationRow;
    return {
      id: r.id,
      memberId: r.member_id,
      memberName: nameById.get(r.member_id) ?? "—",
      amountRand: Number(r.amount_rand),
      method: r.method,
      tokensCredited: r.tokens_credited,
      createdAt: r.created_at,
    };
  });
}

export type RecordDonationInput = {
  memberId: string;
  amountRand: number;
  method: DonationMethod;
};

export async function recordDonation(
  supabase: SupabaseClient,
  clubId: string,
  input: RecordDonationInput,
): Promise<Donation> {
  const { data, error } = await supabase.rpc("record_donation", {
    p_club_id: clubId,
    p_member_id: input.memberId,
    p_amount_rand: input.amountRand,
    p_method: input.method,
  });
  if (error) throw error;

  // The function is declared `returns donations` (a single composite
  // row, not `setof donations`), so PostgREST/supabase-js returns
  // `data` as a single object here, not an array — unlike every other
  // Supabase call in this codebase so far (all `.from(...)` table
  // queries, which return arrays).
  const row = data as DonationRow;

  const { data: member } = await supabase
    .from("members")
    .select("first, last")
    .eq("id", row.member_id)
    .maybeSingle();

  return {
    id: row.id,
    memberId: row.member_id,
    memberName: member ? `${member.first} ${member.last}` : "—",
    amountRand: Number(row.amount_rand),
    method: row.method,
    tokensCredited: row.tokens_credited,
    createdAt: row.created_at,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/donations.test.ts`
Expected: PASS, all tests green. Live Supabase project — this will take longer than a mocked suite.

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/donations.ts tests/donations.test.ts
git commit -m "Add donations data layer (atomic record + today's list)"
```

---

### Task 3: Donations screen UI

**Files:**
- Create: `src/app/[clubSlug]/donations/page.tsx`
- Create: `src/app/[clubSlug]/donations/donations-header.tsx`
- Create: `src/app/[clubSlug]/donations/donations-panel.tsx`
- Create: `src/app/[clubSlug]/donations/actions.ts`

**Interfaces:**
- Consumes: `getTodaysDonations`, `recordDonation`, and the `Donation`/`DonationMethod`/`RecordDonationInput` types from `src/lib/donations.ts` (Task 2). `listMembers`/`MemberListRow` from `src/lib/members.ts` (existing). `resolveClubAccess` from `src/lib/auth/club-access.ts` (existing). `usePageHeader` from `src/lib/page-header-context.tsx` (existing). `useToast` from `src/lib/toast-context.tsx` (existing).

This task has no test file — verified via `tsc`/`build`/manual smoke test, per this project's established convention for UI-only tasks.

- [ ] **Step 1: Create the header component**

Create `src/app/[clubSlug]/donations/donations-header.tsx`:

```tsx
"use client";

import { usePageHeader } from "@/lib/page-header-context";

export function DonationsHeader() {
  usePageHeader({ title: "Donations", subtitle: "Cash → token conversion" });
  return null;
}
```

- [ ] **Step 2: Create the server action**

Create `src/app/[clubSlug]/donations/actions.ts`:

```ts
"use server";

import { createClient } from "@/lib/supabase/server";
import { recordDonation, type RecordDonationInput, type Donation } from "@/lib/donations";

export async function recordDonationAction(
  clubId: string,
  input: RecordDonationInput,
): Promise<{ ok: true; donation: Donation } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const donation = await recordDonation(supabase, clubId, input);
    return { ok: true, donation };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to record donation" };
  }
}
```

- [ ] **Step 3: Create the panel component**

Create `src/app/[clubSlug]/donations/donations-panel.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/lib/toast-context";
import { recordDonationAction } from "./actions";
import type { Donation, DonationMethod } from "@/lib/donations";
import type { MemberListRow } from "@/lib/members";

const METHODS: DonationMethod[] = ["Cash", "Card", "EFT"];

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.charAt(0) ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
  return (first + last).toUpperCase();
}

export function DonationsPanel({
  clubId,
  members,
  donations: initialDonations,
}: {
  clubId: string;
  members: MemberListRow[];
  donations: Donation[];
}) {
  const { showToast } = useToast();
  const [donations, setDonations] = useState(initialDonations);
  const [memberId, setMemberId] = useState(members[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<DonationMethod>("Cash");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSaving] = useTransition();

  const amountNum = Number(amount) || 0;

  function handleRecord() {
    setError(null);
    if (!memberId) {
      setError("Select a member");
      return;
    }
    if (amountNum <= 0) {
      setError("Enter a valid amount");
      return;
    }
    startSaving(async () => {
      const result = await recordDonationAction(clubId, { memberId, amountRand: amountNum, method });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDonations((prev) => [result.donation, ...prev]);
      showToast(`Donation recorded · +${result.donation.tokensCredited} tokens credited`);
      setAmount("");
      setMethod("Cash");
    });
  }

  return (
    <div className="grid grid-cols-[380px_1fr] items-start gap-4">
      <div className="rounded-card border border-border bg-card p-5">
        <div className="mb-1 font-heading text-base font-semibold">Record donation</div>
        <p className="mb-4 text-[12px] text-[#6b6f66]">Cash donation converts 1:1 into tokens.</p>

        <label htmlFor="donationMember" className="mb-1 block text-[11px] text-[#8a8e83]">
          Member
        </label>
        <select
          id="donationMember"
          value={memberId}
          onChange={(e) => setMemberId(e.target.value)}
          className="mb-3.5 w-full rounded-[9px] border border-input bg-card px-3 py-2.5 text-[13px]"
        >
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.first} {m.last} ({m.code})
            </option>
          ))}
        </select>

        <label htmlFor="donationAmount" className="mb-1 block text-[11px] text-[#8a8e83]">
          Amount (R)
        </label>
        <input
          id="donationAmount"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
          className="mb-3.5 w-full rounded-[9px] border border-input px-3 py-3 font-mono text-xl font-semibold"
        />

        <div className="mb-1.5 text-[11px] text-[#8a8e83]">Method</div>
        <div className="mb-4 flex gap-2">
          {METHODS.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMethod(m)}
              className="rounded-[8px] border px-3 py-[7px] text-[12.5px] font-medium"
              style={
                method === m
                  ? { background: "var(--primary)", borderColor: "var(--primary)", color: "#fff" }
                  : { background: "var(--card)", borderColor: "var(--border)", color: "#4a4e45" }
              }
            >
              {m}
            </button>
          ))}
        </div>

        <div
          className="mb-4 flex items-center justify-between rounded-[10px] p-3.5"
          style={{ background: "var(--accent)" }}
        >
          <div className="text-[12px]" style={{ color: "#3f6a49" }}>
            Tokens credited
          </div>
          <div className="font-mono text-xl font-semibold text-primary">+{amountNum}</div>
        </div>

        {error && <p className="mb-3 text-[12.5px] text-destructive">{error}</p>}

        <button
          type="button"
          onClick={handleRecord}
          disabled={isSaving || members.length === 0}
          className="w-full rounded-[9px] py-3 text-[14px] font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#e4e1d7] disabled:text-[#a29c8c]"
          style={!isSaving && members.length > 0 ? { background: "var(--primary)" } : undefined}
        >
          {isSaving ? "Recording…" : "Record donation"}
        </button>
      </div>

      <div className="rounded-card border border-border bg-card p-[18px]">
        <div className="mb-1.5 font-heading text-[15px] font-semibold">Today&apos;s donations</div>
        {donations.length === 0 ? (
          <div className="px-2 py-10 text-center text-[13px] text-[#6b6f66]">
            No donations recorded today yet.
          </div>
        ) : (
          donations.map((d) => (
            <div
              key={d.id}
              className="flex items-center gap-3 border-b border-[#f0eee6] py-[11px] last:border-b-0"
            >
              <div className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-primary">
                {initialsFromName(d.memberName)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{d.memberName}</div>
                <div className="text-[11px] text-[#9a9e93]">
                  {d.method} ·{" "}
                  {new Date(d.createdAt).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
              <div className="text-right">
                <div className="font-mono text-[13px] font-semibold">R{d.amountRand}</div>
                <div className="font-mono text-[11px] text-primary">+{d.tokensCredited} tok</div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create the page**

Create `src/app/[clubSlug]/donations/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import { listMembers } from "@/lib/members";
import { getTodaysDonations } from "@/lib/donations";
import { DonationsHeader } from "./donations-header";
import { DonationsPanel } from "./donations-panel";

export default async function DonationsPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const supabase = await createClient();
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();

  const [members, donations] = await Promise.all([
    listMembers(supabase, access.clubId),
    getTodaysDonations(supabase, access.clubId),
  ]);

  return (
    <>
      <DonationsHeader />
      <DonationsPanel clubId={access.clubId} members={members} donations={donations} />
    </>
  );
}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Build**

Run: `pnpm build`
Expected: succeeds, route table includes `/[clubSlug]/donations`.

- [ ] **Step 7: Manual smoke test**

Use an isolated throwaway test club + throwaway admin user via the service-role key (`createAdminClient` from `src/lib/supabase/admin.ts`) — NOT the real shared `demo` club. Sign in, load `/donations`, and confirm: (a) the member dropdown lists real club members in the `"{first} {last} ({code})"` format; (b) recording a donation both inserts the row AND actually increments the member's `token_balance` in the database (query it directly to confirm — this is the single most important behavior in this feature); (c) the new donation appears at the top of "Today's donations" with a success toast. Delete the throwaway club/user and any created rows immediately after, and verify deletion via a follow-up query.

- [ ] **Step 8: Commit**

```bash
git add src/app/\[clubSlug\]/donations/page.tsx src/app/\[clubSlug\]/donations/donations-header.tsx src/app/\[clubSlug\]/donations/donations-panel.tsx src/app/\[clubSlug\]/donations/actions.ts
git commit -m "Build the Donations screen (record + today's list)"
```

---

## Self-Review Notes

- **Spec coverage:** the atomic RPC function (Task 1), the data layer including the today-filter and cross-entity ownership check (Task 2), the real member picker + record panel + today's list, staying on the page after recording (Task 3) — every section of `docs/superpowers/specs/2026-07-29-donations-design.md` maps to a task.
- **Type consistency checked:** `Donation`/`DonationMethod`/`RecordDonationInput` field names match exactly between Task 2's implementation, Task 2's tests, and Task 3's consumption (`d.amountRand`, `d.tokensCredited`, `d.memberName`, `d.method`, `d.createdAt`; `result.donation`). `MemberListRow` fields (`m.id`, `m.first`, `m.last`, `m.code`) confirmed against the actual current `src/lib/members.ts`.
- **No placeholders:** every step has complete, runnable code.
- **Fixture verification:** `tests/rls/fixtures.ts` confirmed (by direct read) to have `memberId`/`donationId` on `SeededClub`, `token_balance: 100` on the seeded member, and no explicit `created_at` on the seeded donation (defaults to `now()`, landing inside today's SAST window) — Task 2's tests don't invent unverified fixture assumptions.
