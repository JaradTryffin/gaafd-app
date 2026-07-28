# Members List Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `/[clubSlug]/members` — a searchable, status-filterable table of a club's members, currently unbuilt (only `/members/register/*` exists; the sidebar's "Members" link 404s today).

**Architecture:** Extend the existing `src/lib/members.ts` with a `listMembers` read function, then a Server Component (data fetch) + tiny header Client Component + interactive table Client Component, mirroring the Dashboard screen's already-reviewed pattern exactly.

**Tech Stack:** Next.js App Router, TypeScript, Supabase JS client, Vitest.

## Global Constraints

- Reuse `src/lib/supabase/server.ts`, `src/lib/auth/club-access.ts`'s `resolveClubAccess`, `src/lib/page-header-context.tsx`'s `usePageHeader` exactly as they exist — do not modify any of them.
- No PostgREST relation embedding (`.select("a, b(c,d)")`) anywhere — this codebase's existing lib files always do sequential queries + JS joins instead.
- Design tokens: use the `@theme`-mapped Tailwind utilities (`rounded-card`, `bg-card`, `border-border`, `bg-accent`, `text-primary`, `bg-status-active-bg`/`text-status-active-fg`, `bg-status-inactive-bg`/`text-status-inactive-fg`, `font-heading`, `font-mono`) matching every prior screen; arbitrary `text-[#hex]`/`rounded-[Npx]`/inline `style` only for values genuinely absent from the mapped set.
- pnpm exclusively, Node via `.nvmrc` (run `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use` before any command).
- Commit messages plain, imperative. Work on branch `master` directly (standing consent from all prior phases).
- `tests/rls/fixtures.ts`'s `seedClub()` (used by every test in this plan) already seeds one active member per club ("Test Member", no referrer, `joined_at` = now) as shared infrastructure — this row will always be present in `listMembers`'s results. Tests must account for this baseline, not assume an empty starting list.

---

### Task 1: `listMembers` data function

**Files:**
- Modify: `src/lib/members.ts` (append — existing file already has `RegisterMemberInput`, `nextMemberCode`, `registerMember`; do not alter those)
- Test: `tests/members.test.ts` (new file — separate from `tests/registration.test.ts`, which covers the registration/sign flow specifically; this is a different concern despite living in the same `members.ts` file)

**Interfaces:**
- Produces: `type MemberListRow = { id: string; first: string; last: string; code: string; type: "Full member" | "Day pass" | "Trial"; tokenBalance: number; referrerName: string | null; status: "active" | "inactive" }`, `listMembers(supabase, clubId): Promise<MemberListRow[]>` — consumed by Task 2.

- [ ] **Step 1: Write the failing tests**

Create `tests/members.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use && pnpm vitest run tests/members.test.ts`
Expected: FAIL — `listMembers is not a function` (export doesn't exist yet).

- [ ] **Step 3: Implement**

Append to `src/lib/members.ts` (below the existing `registerMember` function — do not modify anything above it):

```ts
export type MemberListRow = {
  id: string;
  first: string;
  last: string;
  code: string;
  type: "Full member" | "Day pass" | "Trial";
  tokenBalance: number;
  referrerName: string | null;
  status: "active" | "inactive";
};

export async function listMembers(
  supabase: SupabaseClient,
  clubId: string,
): Promise<MemberListRow[]> {
  const { data, error } = await supabase
    .from("members")
    .select("id, first, last, code, type, token_balance, referrer_id, status")
    .eq("club_id", clubId)
    .order("joined_at", { ascending: false });
  if (error) throw error;

  const rows = data ?? [];
  // A referrer is always another member of the same club, already present
  // in this same result set — no second query needed.
  const nameById = new Map(rows.map((m) => [m.id as string, `${m.first} ${m.last}`]));

  return rows.map((m) => ({
    id: m.id as string,
    first: m.first as string,
    last: m.last as string,
    code: m.code as string,
    type: m.type as "Full member" | "Day pass" | "Trial",
    tokenBalance: m.token_balance as number,
    referrerName: m.referrer_id ? (nameById.get(m.referrer_id as string) ?? null) : null,
    status: m.status as "active" | "inactive",
  }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/members.test.ts`
Expected: PASS, all 4 tests green. (Live Supabase project — this will take longer than a mocked suite.)

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/members.ts tests/members.test.ts
git commit -m "Add listMembers for the Members list screen"
```

---

### Task 2: Members list screen

**Files:**
- Create: `src/app/[clubSlug]/members/page.tsx`
- Create: `src/app/[clubSlug]/members/members-header.tsx`
- Create: `src/app/[clubSlug]/members/members-table.tsx`

**Interfaces:**
- Consumes: `listMembers`, `type MemberListRow` from `src/lib/members.ts` (Task 1). `resolveClubAccess` from `src/lib/auth/club-access.ts` (existing — returns `{ clubId, slug, name, initials, accentColor, plan, role }`). `usePageHeader` from `src/lib/page-header-context.tsx` (existing).

This task has no test file — verified via `tsc`/`build`/manual smoke test, per this project's established convention for UI-only tasks.

- [ ] **Step 1: Create the header component**

Create `src/app/[clubSlug]/members/members-header.tsx` (same shape as `src/app/[clubSlug]/dashboard-header.tsx`):

```tsx
"use client";

import { usePageHeader } from "@/lib/page-header-context";

export function MembersHeader({ clubName, count }: { clubName: string; count: number }) {
  usePageHeader({ title: "Members", subtitle: `${count} registered · ${clubName}` });
  return null;
}
```

- [ ] **Step 2: Create the table component**

Create `src/app/[clubSlug]/members/members-table.tsx`:

```tsx
"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { MemberListRow } from "@/lib/members";

const STATUS_FILTERS = ["All", "Active", "Inactive"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

function initials(first: string, last: string): string {
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

export function MembersTable({
  clubSlug,
  members,
}: {
  clubSlug: string;
  members: MemberListRow[];
}) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return members
      .filter((m) => statusFilter === "All" || m.status === statusFilter.toLowerCase())
      .filter((m) => !q || `${m.first} ${m.last} ${m.code}`.toLowerCase().includes(q));
  }, [members, statusFilter, search]);

  return (
    <div>
      <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
        <div className="flex gap-[7px]">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setStatusFilter(f)}
              className="rounded-[8px] border px-3 py-[7px] text-[12.5px] font-medium"
              style={
                statusFilter === f
                  ? { background: "var(--primary)", borderColor: "var(--primary)", color: "#fff" }
                  : { background: "var(--card)", borderColor: "var(--border)", color: "#4a4e45" }
              }
            >
              {f}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search members…"
          aria-label="Search members"
          className="w-[220px] rounded-[9px] border border-input bg-card px-3 py-[7px] text-[13px]"
        />
        <Link
          href={`/${clubSlug}/members/register`}
          className="ml-auto rounded-[9px] px-[15px] py-[9px] text-[13px] font-semibold text-white"
          style={{ background: "var(--primary)" }}
        >
          + Register member
        </Link>
      </div>

      <div className="rounded-card border border-border bg-card">
        {members.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <div className="text-[13.5px] text-[#6b6f66]">
              No members yet — register your first member to get started.
            </div>
            <Link
              href={`/${clubSlug}/members/register`}
              className="rounded-[9px] px-5 py-2.5 text-[13px] font-semibold text-white"
              style={{ background: "var(--primary)" }}
            >
              + Register member
            </Link>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-16 text-center text-[13.5px] text-[#6b6f66]">
            No members match your filters.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[2fr_1fr_1fr_1fr_90px] gap-3 border-b border-border bg-muted px-[18px] py-3 text-[11px] font-semibold uppercase tracking-[.05em] text-[#8a8e83]">
              <div>Member</div>
              <div>Type</div>
              <div>Balance</div>
              <div>Referred by</div>
              <div>Status</div>
            </div>
            {filtered.map((m) => (
              <div
                key={m.id}
                className="grid grid-cols-[2fr_1fr_1fr_1fr_90px] items-center gap-3 border-b border-[#f4f2ea] px-[18px] py-[13px] last:border-b-0"
              >
                <div className="flex min-w-0 items-center gap-[11px]">
                  <div className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-full bg-accent text-xs font-semibold text-primary">
                    {initials(m.first, m.last)}
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-medium">
                      {m.first} {m.last}
                    </div>
                    <div className="font-mono text-[11px] text-[#9a9e93]">{m.code}</div>
                  </div>
                </div>
                <div className="text-[13px] text-[#4a4e45]">{m.type}</div>
                <div className="font-mono text-[13px] font-medium text-primary">
                  {m.tokenBalance}
                </div>
                <div className="text-[13px] text-[#6b6f66]">{m.referrerName ?? "—"}</div>
                <div>
                  <span
                    className={
                      m.status === "active"
                        ? "rounded-full bg-status-active-bg px-2.5 py-1 text-[11px] font-medium text-status-active-fg"
                        : "rounded-full bg-status-inactive-bg px-2.5 py-1 text-[11px] font-medium text-status-inactive-fg"
                    }
                  >
                    {m.status}
                  </span>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create the page**

Create `src/app/[clubSlug]/members/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import { listMembers } from "@/lib/members";
import { MembersHeader } from "./members-header";
import { MembersTable } from "./members-table";

export default async function MembersPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const supabase = await createClient();
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();

  const members = await listMembers(supabase, access.clubId);

  return (
    <>
      <MembersHeader clubName={access.name} count={members.length} />
      <MembersTable clubSlug={clubSlug} members={members} />
    </>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Build**

Run: `pnpm build`
Expected: succeeds, route table includes `/[clubSlug]/members`.

- [ ] **Step 6: Manual smoke test**

The `/[clubSlug]/members` route is auth-gated (`resolveClubAccess` requires a signed-in session), so a bare unauthenticated `curl` will 307 to `/login` regardless of correctness — that's expected, not a bug. Verify with an authenticated session instead: reuse the same approach as the Dashboard task's smoke test (a throwaway admin user added to a fixture-created test club via the service-role key — NOT the shared real `demo` club — signed in via `supabase-js`, session cookie passed to `curl`), or if a simpler authenticated path is available in this environment, use that instead. Confirm the response contains "Members", "Register member", and either a real member row or the "No members yet" empty-state copy. Clean up any throwaway auth user/test club created for this step immediately after.

- [ ] **Step 7: Commit**

```bash
git add src/app/\[clubSlug\]/members/page.tsx src/app/\[clubSlug\]/members/members-header.tsx src/app/\[clubSlug\]/members/members-table.tsx
git commit -m "Build the Members list screen"
```

---

## Self-Review Notes

- **Spec coverage:** data layer (Task 1), screen + both empty states + status filter + search + register link (Task 2) — every section of `docs/superpowers/specs/2026-07-28-members-list-design.md` maps to a task.
- **Type consistency checked:** `MemberListRow` field names (`id`, `first`, `last`, `code`, `type`, `tokenBalance`, `referrerName`, `status`) match exactly between Task 1's implementation, Task 1's tests, and Task 2's consumption in `members-table.tsx`.
- **No placeholders:** every step has complete, runnable code.
- **Deviation from Dashboard's smoke-test precedent, deliberate:** Task 2 Step 6 explicitly directs the implementer away from touching the real `demo` club (unlike the Dashboard task, which did and required a post-hoc controller verification) — using a fixture-created throwaway club instead avoids that extra verification step entirely.
