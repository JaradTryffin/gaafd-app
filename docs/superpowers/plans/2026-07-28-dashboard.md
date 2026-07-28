# Dashboard Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder club-root page with the real Dashboard — KPI cards, low-stock alerts, and a recent-activity feed, backed by real Supabase data where that data exists today, with honest placeholders for the pieces (tokens dispensed, 7-day chart) that need a future screen's data model.

**Architecture:** Two new `src/lib` modules (pure formatting helpers, then Supabase-backed dashboard queries), then one screen task that wires them into `src/app/[clubSlug]/page.tsx`. Same Server Component (data fetch) + tiny Client Component (header) pairing used by every prior screen in this project.

**Tech Stack:** Next.js App Router, TypeScript, Supabase JS client, Vitest.

## Global Constraints

- Reuse `src/lib/supabase/server.ts`, `src/lib/auth/club-access.ts`'s `resolveClubAccess`, `src/lib/page-header-context.tsx`'s `usePageHeader` exactly as they exist — do not modify any of them.
- pnpm exclusively, Node via `.nvmrc` (run `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use` before any command).
- Commit messages plain, imperative. Work on branch `master` directly (standing consent from all prior phases).
- Design tokens: use the `@theme`-mapped Tailwind utilities (`rounded-card`, `bg-card`, `border-border`, `text-destructive`, `font-heading`, `font-mono`, `bg-accent`, `bg-primary`, `text-primary`) matching every prior screen; arbitrary `text-[#hex]` / `rounded-[Npx]` / inline `style` only for exact values genuinely absent from the mapped token set. Match the design mock's pixel values exactly (this project's fidelity bar, stated in the design handoff README, is "high-fidelity... recreate the UI closely") — don't round to the nearest scale token when the mock specifies an exact px value the scale doesn't hit.
- No PostgREST relation embedding (`.select("a, b(c, d)")`) anywhere in this plan — every existing lib file in this codebase (`contracts.ts`, `members.ts`) does sequential queries + JS joins instead, and this plan follows that convention for consistency.
- `products`, `inventory_moves`, `donations` tables and their RLS policies already exist (phase 1, `supabase/migrations/20260727130000_core_schema.sql` + `20260727130100_rls_policies.sql`) — no new migration in this plan.
- `tests/rls/fixtures.ts`'s `seedClub()` (used by every test in this plan) already seeds, per club: one active member ("Test Member", `joined_at` = now), one donation (R300, method "Cash", 300 tokens credited, `created_at` = now), and one product ("Test Product", category "Flower") with a 100-unit `PURCHASE` inventory move (stock = 100, well above the low-stock threshold). Tests must account for this non-zero baseline — assert deltas after adding new rows, not absolute counts from an assumed-empty state.

---

### Task 1: Pure formatting helpers

**Files:**
- Create: `src/lib/format.ts`
- Test: `tests/format.test.ts`

**Interfaces:**
- Produces: `formatRand(amount: number): string`, `formatRelativeTime(timestamp: string): string`, `sastDayRange(daysAgo: number): { start: string; end: string }`, `sastMonthStart(): string` — all pure, no Supabase, used by Task 2 (`sastDayRange`, `sastMonthStart`) and Task 3 (`formatRand`, `formatRelativeTime`).

- [ ] **Step 1: Write the failing tests**

Create `tests/format.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatRand, formatRelativeTime, sastDayRange, sastMonthStart } from "@/lib/format";

afterEach(() => {
  vi.useRealTimers();
});

describe("formatRand", () => {
  it("formats a whole number with comma grouping and an R prefix", () => {
    expect(formatRand(6340)).toBe("R 6,340");
  });

  it("formats zero", () => {
    expect(formatRand(0)).toBe("R 0");
  });

  it("formats large amounts with multiple grouping separators", () => {
    expect(formatRand(1234567)).toBe("R 1,234,567");
  });

  it("rounds fractional rand to the nearest whole number", () => {
    expect(formatRand(150.5)).toBe("R 151");
  });
});

describe("formatRelativeTime", () => {
  it("returns 'just now' for under a minute", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T12:00:30.000Z"));
    expect(formatRelativeTime("2026-07-25T12:00:00.000Z")).toBe("just now");
  });

  it("returns minutes for under an hour", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T12:02:00.000Z"));
    expect(formatRelativeTime("2026-07-25T12:00:00.000Z")).toBe("2m");
  });

  it("returns 59m just under the hour boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T12:59:00.000Z"));
    expect(formatRelativeTime("2026-07-25T12:00:00.000Z")).toBe("59m");
  });

  it("returns hours at and after the hour boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T13:00:00.000Z"));
    expect(formatRelativeTime("2026-07-25T12:00:00.000Z")).toBe("1h");
  });

  it("returns days after the 24h boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T13:00:01.000Z"));
    expect(formatRelativeTime("2026-07-25T12:00:00.000Z")).toBe("1d");
  });
});

describe("sastDayRange", () => {
  it("keeps a timestamp just before SAST midnight in the same SAST day", () => {
    // 21:59:59Z = 23:59:59 SAST (UTC+2) -> still 25 July SAST.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T21:59:59.000Z"));
    const today = sastDayRange(0);
    expect(today.start).toBe("2026-07-24T22:00:00.000Z");
    expect(today.end).toBe("2026-07-25T22:00:00.000Z");
  });

  it("rolls over to the next SAST day exactly at the boundary", () => {
    // 22:00:00Z = 00:00:00 SAST the next day -> 26 July SAST.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T22:00:00.000Z"));
    const today = sastDayRange(0);
    expect(today.start).toBe("2026-07-25T22:00:00.000Z");
    expect(today.end).toBe("2026-07-26T22:00:00.000Z");
  });

  it("yesterday's range ends exactly where today's range starts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T21:59:59.000Z"));
    expect(sastDayRange(1).end).toBe(sastDayRange(0).start);
  });
});

describe("sastMonthStart", () => {
  it("stays in the previous month just before the SAST month boundary", () => {
    // 21:59:00Z = 23:59 SAST on 31 July -> still July.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T21:59:00.000Z"));
    expect(sastMonthStart()).toBe("2026-06-30T22:00:00.000Z");
  });

  it("rolls to the new month exactly at the SAST boundary", () => {
    // 22:00:00Z on 31 July = 00:00 SAST on 1 August.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T22:00:00.000Z"));
    expect(sastMonthStart()).toBe("2026-07-31T22:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use && pnpm vitest run tests/format.test.ts`
Expected: FAIL — `Cannot find module '@/lib/format'` (file doesn't exist yet).

- [ ] **Step 3: Implement**

Create `src/lib/format.ts`:

```ts
// South Africa is UTC+2 year-round (no DST) — a fixed offset is correct,
// not a simplification that will drift.
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

export function formatRand(amount: number): string {
  // en-US locale purely for comma grouping to match the design mock's
  // "R 6,340" — not a claim about South African number formatting.
  return `R ${Math.round(amount).toLocaleString("en-US")}`;
}

export function formatRelativeTime(timestamp: string): string {
  const diffMs = Date.now() - new Date(timestamp).getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d`;
}

export function sastDayRange(daysAgo: number): { start: string; end: string } {
  const shifted = new Date(Date.now() + SAST_OFFSET_MS);
  const sastYear = shifted.getUTCFullYear();
  const sastMonth = shifted.getUTCMonth();
  const sastDate = shifted.getUTCDate();
  // Date.UTC(..., sastDate - daysAgo) naively treats the SAST calendar date
  // as if it were UTC midnight, then subtracting the offset converts that
  // to the real UTC instant of SAST midnight. Date.UTC handles day/month
  // underflow (e.g. date 0) correctly on its own.
  const startMs = Date.UTC(sastYear, sastMonth, sastDate - daysAgo) - SAST_OFFSET_MS;
  const endMs = startMs + 24 * 60 * 60 * 1000;
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}

export function sastMonthStart(): string {
  const shifted = new Date(Date.now() + SAST_OFFSET_MS);
  const sastYear = shifted.getUTCFullYear();
  const sastMonth = shifted.getUTCMonth();
  const startMs = Date.UTC(sastYear, sastMonth, 1) - SAST_OFFSET_MS;
  return new Date(startMs).toISOString();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/format.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/format.ts tests/format.test.ts
git commit -m "Add dashboard formatting helpers (Rand, relative time, SAST day/month boundaries)"
```

---

### Task 2: Dashboard data layer

**Files:**
- Create: `src/lib/dashboard.ts`
- Test: `tests/dashboard.test.ts`

**Interfaces:**
- Consumes: `sastDayRange`, `sastMonthStart` from `src/lib/format.ts` (Task 1). `SeededData`, `seedTenants`, `cleanupTenants`, `signInAs` from `tests/rls/fixtures.ts` (existing). `createAdminClient` from `src/lib/supabase/admin.ts` (existing).
- Produces: `LOW_STOCK_THRESHOLD: number`, `type DashboardKpis`, `type LowStockAlert`, `type ActivityItem`, `getDashboardKpis(supabase, clubId): Promise<DashboardKpis>`, `getLowStockAlerts(supabase, clubId, limit): Promise<LowStockAlert[]>`, `getRecentActivity(supabase, clubId, limit): Promise<ActivityItem[]>` — all consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

Create `tests/dashboard.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedTenants, cleanupTenants, signInAs, type SeededData } from "./rls/fixtures";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getDashboardKpis,
  getLowStockAlerts,
  getRecentActivity,
  LOW_STOCK_THRESHOLD,
} from "@/lib/dashboard";

let data: SeededData;
let clubAClient: SupabaseClient;
let clubBClient: SupabaseClient;
const cleanupMemberIds: string[] = [];
const cleanupDonationIds: string[] = [];
const cleanupMoveIds: string[] = [];

beforeAll(async () => {
  data = await seedTenants();
  clubAClient = await signInAs(data.clubA.adminEmail, data.clubA.adminPassword);
  clubBClient = await signInAs(data.clubB.adminEmail, data.clubB.adminPassword);
}, 30000);

afterAll(async () => {
  const admin = createAdminClient();
  if (cleanupMoveIds.length > 0) {
    await admin.from("inventory_moves").delete().in("id", cleanupMoveIds);
  }
  if (cleanupDonationIds.length > 0) {
    await admin.from("donations").delete().in("id", cleanupDonationIds);
  }
  if (cleanupMemberIds.length > 0) {
    await admin.from("members").delete().in("id", cleanupMemberIds);
  }
  if (data) {
    await cleanupTenants(data);
  }
}, 30000);

describe("getDashboardKpis", () => {
  it("counts active members and this month's new members, as a delta over the fixture baseline", async () => {
    // seedClub() already creates one active member per club, so the
    // baseline isn't zero — assert the delta after adding one more.
    const before = await getDashboardKpis(clubAClient, data.clubA.clubId);

    const admin = createAdminClient();
    const { data: newMember, error } = await admin
      .from("members")
      .insert({
        club_id: data.clubA.clubId,
        code: "DASH-TEST-0001",
        first: "Dash",
        last: "Kpi",
        type: "Full member",
        status: "active",
      })
      .select()
      .single();
    if (error) throw error;
    cleanupMemberIds.push(newMember.id);

    const after = await getDashboardKpis(clubAClient, data.clubA.clubId);
    expect(after.activeMembers).toBe(before.activeMembers + 1);
    expect(after.newMembersThisMonth).toBe(before.newMembersThisMonth + 1);
  });

  it("sums today's donations as a delta over the fixture baseline", async () => {
    // seedClub() also seeds one R300 donation at "now" per club, already
    // inside today's window and included in `before`.
    const before = await getDashboardKpis(clubAClient, data.clubA.clubId);

    const admin = createAdminClient();
    const { data: donation, error } = await admin
      .from("donations")
      .insert({
        club_id: data.clubA.clubId,
        member_id: data.clubA.memberId,
        amount_rand: 150,
        method: "Card",
        tokens_credited: 150,
      })
      .select()
      .single();
    if (error) throw error;
    cleanupDonationIds.push(donation.id);

    const after = await getDashboardKpis(clubAClient, data.clubA.clubId);
    expect(after.donationsTodayRand).toBe(before.donationsTodayRand + 150);
  });

  it("does not leak club A's new members or donations into club B's KPIs", async () => {
    const clubBBefore = await getDashboardKpis(clubBClient, data.clubB.clubId);

    const admin = createAdminClient();
    const { data: extraMember, error: memberError } = await admin
      .from("members")
      .insert({
        club_id: data.clubA.clubId,
        code: "DASH-TEST-ISO-0001",
        first: "Isolation",
        last: "Check",
        type: "Full member",
        status: "active",
      })
      .select()
      .single();
    if (memberError) throw memberError;
    cleanupMemberIds.push(extraMember.id);

    const { data: extraDonation, error: donationError } = await admin
      .from("donations")
      .insert({
        club_id: data.clubA.clubId,
        member_id: data.clubA.memberId,
        amount_rand: 500,
        method: "EFT",
        tokens_credited: 500,
      })
      .select()
      .single();
    if (donationError) throw donationError;
    cleanupDonationIds.push(extraDonation.id);

    const clubBAfter = await getDashboardKpis(clubBClient, data.clubB.clubId);
    expect(clubBAfter.activeMembers).toBe(clubBBefore.activeMembers);
    expect(clubBAfter.donationsTodayRand).toBe(clubBBefore.donationsTodayRand);
  });

  it("reports zero low-stock items when every product is well-stocked", async () => {
    // seedClub()'s fixture product has a PURCHASE move of qty 100, far
    // above LOW_STOCK_THRESHOLD.
    const kpis = await getDashboardKpis(clubAClient, data.clubA.clubId);
    expect(kpis.lowStockCount).toBe(0);
  });

  it("counts a product once its derived stock drops to the low-stock threshold", async () => {
    const admin = createAdminClient();
    const { data: move, error } = await admin
      .from("inventory_moves")
      .insert({
        club_id: data.clubA.clubId,
        product_id: data.clubA.productId,
        type: "SALE",
        qty: -95, // fixture product started at 100 -> now 5, <= threshold
      })
      .select()
      .single();
    if (error) throw error;
    cleanupMoveIds.push(move.id);

    const kpis = await getDashboardKpis(clubAClient, data.clubA.clubId);
    expect(kpis.lowStockCount).toBe(1);
  });
});

describe("getLowStockAlerts", () => {
  // Depends on the previous describe block's stock-depleting move having
  // already run — Vitest runs `it` blocks within a file in declaration
  // order, and this codebase's other test files already rely on that
  // (see tests/contracts.test.ts).
  it("lists the low-stock product with its current stock, sorted lowest first", async () => {
    const alerts = await getLowStockAlerts(clubAClient, data.clubA.clubId, 5);
    const fixtureAlert = alerts.find((a) => a.productId === data.clubA.productId);
    expect(fixtureAlert).toBeDefined();
    expect(fixtureAlert!.stock).toBeLessThanOrEqual(LOW_STOCK_THRESHOLD);
    expect(fixtureAlert!.name).toBe("Test Product");
  });

  it("does not return club A's low-stock product to club B", async () => {
    const clubBAlerts = await getLowStockAlerts(clubBClient, data.clubB.clubId, 5);
    const ids = clubBAlerts.map((a) => a.productId);
    expect(ids).not.toContain(data.clubA.productId);
  });
});

describe("getRecentActivity", () => {
  it("merges donations and member registrations newest-first, scoped to the caller's club", async () => {
    const admin = createAdminClient();
    const { data: newMember, error: memberError } = await admin
      .from("members")
      .insert({
        club_id: data.clubA.clubId,
        code: "DASH-TEST-0002",
        first: "Activity",
        last: "Newest",
        type: "Trial",
        status: "active",
      })
      .select()
      .single();
    if (memberError) throw memberError;
    cleanupMemberIds.push(newMember.id);

    const activity = await getRecentActivity(clubAClient, data.clubA.clubId, 10);
    // The just-inserted member has the newest timestamp of anything
    // seeded so far in this file, so it must be first.
    expect(activity[0]).toMatchObject({ kind: "member", id: newMember.id });

    // No club B row id should ever appear in club A's feed.
    const ids = activity.map((a) => a.id);
    expect(ids).not.toContain(data.clubB.memberId);
    expect(ids).not.toContain(data.clubB.donationId);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/dashboard.test.ts`
Expected: FAIL — `Cannot find module '@/lib/dashboard'`.

- [ ] **Step 3: Implement**

Create `src/lib/dashboard.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { sastDayRange, sastMonthStart } from "@/lib/format";

export const LOW_STOCK_THRESHOLD = 8;

export type DashboardKpis = {
  activeMembers: number;
  newMembersThisMonth: number;
  donationsTodayRand: number;
  donationsDelta: { text: string; positive: boolean } | null;
  lowStockCount: number;
};

function computeDonationsDelta(
  today: number,
  yesterday: number,
): { text: string; positive: boolean } | null {
  if (yesterday === 0) {
    return today > 0 ? { text: "New today", positive: true } : null;
  }
  const diff = today - yesterday;
  const pct = Math.round((Math.abs(diff) / yesterday) * 100);
  const positive = diff >= 0;
  const arrow = positive ? "▲" : "▼";
  return { text: `${arrow} ${pct}% vs yesterday`, positive };
}

export async function getDashboardKpis(
  supabase: SupabaseClient,
  clubId: string,
): Promise<DashboardKpis> {
  const { count: activeMembers, error: activeError } = await supabase
    .from("members")
    .select("id", { count: "exact", head: true })
    .eq("club_id", clubId)
    .eq("status", "active");
  if (activeError) throw activeError;

  const { count: newMembersThisMonth, error: newMembersError } = await supabase
    .from("members")
    .select("id", { count: "exact", head: true })
    .eq("club_id", clubId)
    .gte("joined_at", sastMonthStart());
  if (newMembersError) throw newMembersError;

  const today = sastDayRange(0);
  const { data: todayDonations, error: todayError } = await supabase
    .from("donations")
    .select("amount_rand")
    .eq("club_id", clubId)
    .gte("created_at", today.start)
    .lt("created_at", today.end);
  if (todayError) throw todayError;
  const donationsTodayRand = (todayDonations ?? []).reduce(
    (sum, d) => sum + Number(d.amount_rand),
    0,
  );

  const yesterday = sastDayRange(1);
  const { data: yesterdayDonations, error: yesterdayError } = await supabase
    .from("donations")
    .select("amount_rand")
    .eq("club_id", clubId)
    .gte("created_at", yesterday.start)
    .lt("created_at", yesterday.end);
  if (yesterdayError) throw yesterdayError;
  const donationsYesterdayRand = (yesterdayDonations ?? []).reduce(
    (sum, d) => sum + Number(d.amount_rand),
    0,
  );

  const { data: products, error: productsError } = await supabase
    .from("products")
    .select("id")
    .eq("club_id", clubId)
    .eq("active", true);
  if (productsError) throw productsError;
  const productIds = (products ?? []).map((p) => p.id);

  let lowStockCount = 0;
  if (productIds.length > 0) {
    const { data: stockRows, error: stockError } = await supabase
      .from("product_stock")
      .select("stock")
      .eq("club_id", clubId)
      .in("product_id", productIds)
      .lte("stock", LOW_STOCK_THRESHOLD);
    if (stockError) throw stockError;
    lowStockCount = (stockRows ?? []).length;
  }

  return {
    activeMembers: activeMembers ?? 0,
    newMembersThisMonth: newMembersThisMonth ?? 0,
    donationsTodayRand,
    donationsDelta: computeDonationsDelta(donationsTodayRand, donationsYesterdayRand),
    lowStockCount,
  };
}

export type LowStockAlert = {
  productId: string;
  name: string;
  category: string;
  unit: string;
  stock: number;
};

export async function getLowStockAlerts(
  supabase: SupabaseClient,
  clubId: string,
  limit: number,
): Promise<LowStockAlert[]> {
  const { data: products, error: productsError } = await supabase
    .from("products")
    .select("id, name, category, unit")
    .eq("club_id", clubId)
    .eq("active", true);
  if (productsError) throw productsError;
  if (!products || products.length === 0) return [];

  const { data: stockRows, error: stockError } = await supabase
    .from("product_stock")
    .select("product_id, stock")
    .eq("club_id", clubId)
    .in(
      "product_id",
      products.map((p) => p.id),
    )
    .lte("stock", LOW_STOCK_THRESHOLD);
  if (stockError) throw stockError;

  const stockByProductId = new Map((stockRows ?? []).map((r) => [r.product_id as string, r.stock as number]));

  return products
    .filter((p) => stockByProductId.has(p.id))
    .map((p) => ({
      productId: p.id as string,
      name: p.name as string,
      category: p.category as string,
      unit: p.unit as string,
      stock: stockByProductId.get(p.id)!,
    }))
    .sort((a, b) => a.stock - b.stock)
    .slice(0, limit);
}

export type ActivityItem =
  | {
      kind: "donation";
      id: string;
      memberName: string;
      method: string;
      tokensCredited: number;
      timestamp: string;
    }
  | {
      kind: "member";
      id: string;
      memberName: string;
      code: string;
      timestamp: string;
    };

export async function getRecentActivity(
  supabase: SupabaseClient,
  clubId: string,
  limit: number,
): Promise<ActivityItem[]> {
  const { data: donationRows, error: donationError } = await supabase
    .from("donations")
    .select("id, member_id, method, tokens_credited, created_at")
    .eq("club_id", clubId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (donationError) throw donationError;

  const { data: recentMemberRows, error: memberError } = await supabase
    .from("members")
    .select("id, first, last, code, joined_at")
    .eq("club_id", clubId)
    .order("joined_at", { ascending: false })
    .limit(limit);
  if (memberError) throw memberError;

  const donorIds = [...new Set((donationRows ?? []).map((d) => d.member_id as string))];
  let donorNamesById = new Map<string, string>();
  if (donorIds.length > 0) {
    const { data: donors, error: donorsError } = await supabase
      .from("members")
      .select("id, first, last")
      .in("id", donorIds);
    if (donorsError) throw donorsError;
    donorNamesById = new Map((donors ?? []).map((m) => [m.id as string, `${m.first} ${m.last}`]));
  }

  const donationItems: ActivityItem[] = (donationRows ?? []).map((d) => ({
    kind: "donation",
    id: d.id as string,
    memberName: donorNamesById.get(d.member_id as string) ?? "A member",
    method: d.method as string,
    tokensCredited: d.tokens_credited as number,
    timestamp: d.created_at as string,
  }));

  const memberItems: ActivityItem[] = (recentMemberRows ?? []).map((m) => ({
    kind: "member",
    id: m.id as string,
    memberName: `${m.first} ${m.last}`,
    code: m.code as string,
    timestamp: m.joined_at as string,
  }));

  return [...donationItems, ...memberItems]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/dashboard.test.ts`
Expected: PASS, all tests green. (Live Supabase project — this will take longer than Task 1's tests.)

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/dashboard.ts tests/dashboard.test.ts
git commit -m "Add dashboard data layer (KPIs, low-stock alerts, recent activity)"
```

---

### Task 3: Dashboard screen

**Files:**
- Modify: `src/app/[clubSlug]/page.tsx` (currently a placeholder Client Component — replace entirely, including its `"use client"` directive)
- Create: `src/app/[clubSlug]/dashboard-header.tsx`

**Interfaces:**
- Consumes: `getDashboardKpis`, `getLowStockAlerts`, `getRecentActivity` from `src/lib/dashboard.ts` (Task 2). `formatRand`, `formatRelativeTime` from `src/lib/format.ts` (Task 1). `resolveClubAccess` from `src/lib/auth/club-access.ts` (existing — returns `{ clubId, slug, name, initials, accentColor, plan, role }`, see `src/lib/auth/club-access.ts:3-11`). `usePageHeader` from `src/lib/page-header-context.tsx` (existing).

This task has no test file — verified via `tsc`/`build`/manual smoke test, per this project's established convention for UI-only tasks (see every prior phase's UI tasks).

- [ ] **Step 1: Create the header component**

Create `src/app/[clubSlug]/dashboard-header.tsx` (same shape as `src/app/[clubSlug]/members/register/success/success-header.tsx`):

```tsx
"use client";

import { usePageHeader } from "@/lib/page-header-context";

export function DashboardHeader({ clubName }: { clubName: string }) {
  usePageHeader({ title: "Dashboard", subtitle: `${clubName} · today` });
  return null;
}
```

- [ ] **Step 2: Replace the placeholder page**

Replace the full contents of `src/app/[clubSlug]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import {
  getDashboardKpis,
  getLowStockAlerts,
  getRecentActivity,
  type ActivityItem,
  type LowStockAlert,
} from "@/lib/dashboard";
import { formatRand, formatRelativeTime } from "@/lib/format";
import { DashboardHeader } from "./dashboard-header";

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const supabase = await createClient();
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();

  const [kpis, lowStockAlerts, activity] = await Promise.all([
    getDashboardKpis(supabase, access.clubId),
    getLowStockAlerts(supabase, access.clubId, 5),
    getRecentActivity(supabase, access.clubId, 8),
  ]);

  return (
    <>
      <DashboardHeader clubName={access.name} />
      <div>
        <div className="grid grid-cols-4 gap-3.5">
          <KpiCard
            label="Active members"
            dotColor="#8ba6ff"
            value={String(kpis.activeMembers)}
            delta={`${kpis.newMembersThisMonth} new this month`}
            deltaColor="#6b6f66"
          />
          <KpiCard
            label="Donations today"
            dotColor="#6fbf82"
            value={formatRand(kpis.donationsTodayRand)}
            delta={kpis.donationsDelta?.text}
            deltaColor={
              kpis.donationsDelta
                ? kpis.donationsDelta.positive
                  ? "#3f7a4e"
                  : "#b4432f"
                : undefined
            }
          />
          <KpiCard
            label="Low-stock items"
            dotColor="#c98f6a"
            value={String(kpis.lowStockCount)}
            delta={kpis.lowStockCount > 0 ? "needs reorder" : "all stocked"}
            deltaColor={kpis.lowStockCount > 0 ? "#b4432f" : "#6b6f66"}
          />
          <KpiCard
            label="Tokens dispensed today"
            dotColor="#e0996a"
            value="—"
            delta="Available once Dispensing ships"
            deltaColor="#8a8e83"
          />
        </div>

        <div className="mt-4 grid grid-cols-[1.6fr_1fr] gap-4">
          <div className="rounded-card border border-border bg-card p-[18px]">
            <div className="mb-3.5 font-heading text-[15px] font-semibold">
              Tokens dispensed · last 7 days
            </div>
            <div className="flex h-[180px] items-center justify-center px-4 text-center text-[12.5px] text-[#9a9e93]">
              No dispensing activity yet — this fills in once the Dispensing screen is live.
            </div>
          </div>

          <div className="rounded-card border border-border bg-card p-[18px]">
            <div className="mb-3 font-heading text-[15px] font-semibold">Low stock alerts</div>
            {lowStockAlerts.length === 0 ? (
              <div className="flex h-[120px] items-center justify-center text-center text-[12.5px] text-[#9a9e93]">
                Nothing low on stock.
              </div>
            ) : (
              lowStockAlerts.map((alert) => <LowStockRow key={alert.productId} alert={alert} />)
            )}
          </div>
        </div>

        <div className="mt-4 rounded-card border border-border bg-card p-[18px]">
          <div className="mb-1.5 font-heading text-[15px] font-semibold">Recent activity</div>
          {activity.length === 0 ? (
            <div className="flex h-[100px] items-center justify-center text-center text-[12.5px] text-[#9a9e93]">
              No activity yet.
            </div>
          ) : (
            activity.map((item) => <ActivityRow key={`${item.kind}-${item.id}`} item={item} />)
          )}
        </div>
      </div>
    </>
  );
}

function KpiCard({
  label,
  dotColor,
  value,
  delta,
  deltaColor,
}: {
  label: string;
  dotColor: string;
  value: string;
  delta?: string;
  deltaColor?: string;
}) {
  return (
    <div className="rounded-card border border-border bg-card p-4">
      <div className="flex items-center gap-[7px] text-xs text-[#6b6f66]">
        <span className="h-[7px] w-[7px] rounded-[2px]" style={{ background: dotColor }} />
        {label}
      </div>
      <div className="mt-[9px] font-mono text-[26px] font-semibold tracking-[-0.02em]">
        {value}
      </div>
      {delta && (
        <div className="mt-[3px] text-[11.5px]" style={{ color: deltaColor }}>
          {delta}
        </div>
      )}
    </div>
  );
}

function LowStockRow({ alert }: { alert: LowStockAlert }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-[#f0eee6] py-2.5 last:border-b-0">
      <div className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[8px] bg-accent font-mono text-[11px] text-[#3f7a4e]">
        {alert.category.slice(0, 3).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{alert.name}</div>
        <div className="text-[11px] text-[#8a8e83]">
          {alert.stock} {alert.unit.includes("g") ? "g" : "u"} left
        </div>
      </div>
      <div className="rounded-[6px] bg-[#f8e9e4] px-[7px] py-0.5 font-mono text-[11px] text-destructive">
        low
      </div>
    </div>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  return (
    <div className="flex items-center gap-3 border-b border-[#f0eee6] py-[11px] last:border-b-0">
      <div
        className="h-2 w-2 flex-none rounded-full"
        style={{ background: item.kind === "donation" ? "#6fbf82" : "#8ba6ff" }}
      />
      <div className="w-[76px] flex-none font-mono text-[11px] text-[#9a9e93]">
        {item.kind === "donation" ? "DONATION" : "MEMBER"}
      </div>
      <div className="flex-1 text-[13px]">
        {item.kind === "donation"
          ? `${item.memberName} donated (${item.method})`
          : `New member registered · ${item.code}`}
      </div>
      <div className="font-mono text-[12px] font-medium text-primary">
        {item.kind === "donation" ? `+${item.tokensCredited}` : ""}
      </div>
      <div className="w-[52px] flex-none text-right text-[11px] text-[#9a9e93]">
        {formatRelativeTime(item.timestamp)}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Build**

Run: `pnpm build`
Expected: succeeds, route table includes `/[clubSlug]`.

- [ ] **Step 5: Manual smoke test**

Run `pnpm dev` in the background, then:
```bash
curl -s -o /tmp/dashboard.html -w "%{http_code}\n" http://localhost:3000/demo
grep -o "Dashboard\|Active members\|Donations today\|Low-stock items\|Tokens dispensed today\|Recent activity\|Low stock alerts" /tmp/dashboard.html
```
Expected: `200`, and all seven strings present (confirms the demo club's real data renders, not just that the page compiles). Stop the dev server afterward.

- [ ] **Step 6: Commit**

```bash
git add src/app/\[clubSlug\]/page.tsx src/app/\[clubSlug\]/dashboard-header.tsx
git commit -m "Build the real Dashboard screen (KPIs, low-stock alerts, recent activity)"
```

---

## Self-Review Notes

- **Spec coverage:** every section of `docs/superpowers/specs/2026-07-28-dashboard-design.md` maps to a task — formatting helpers (Task 1), data layer including the corrected no-embedding approach (Task 2), screen + honest-partial copy (Task 3).
- **Type consistency checked:** `DashboardKpis`/`LowStockAlert`/`ActivityItem` field names match exactly between Task 2's implementation, Task 2's tests, and Task 3's consumption (`kpis.activeMembers`, `kpis.newMembersThisMonth`, `kpis.donationsTodayRand`, `kpis.donationsDelta.{text,positive}`, `kpis.lowStockCount`; `alert.{productId,name,category,unit,stock}`; `item.kind` discriminated union with `{donation: memberName,method,tokensCredited,timestamp}` / `{member: memberName,code,timestamp}`).
- **No placeholders:** every step has complete, runnable code; no "add error handling"-style steps.
