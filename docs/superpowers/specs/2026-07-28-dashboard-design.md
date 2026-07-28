# Dashboard Screen — Design Spec

**Status:** Approved
**Scope:** Phase 5, screen 1 of GaafD (South African cannabis social club SaaS). Replaces the placeholder club-root page (`src/app/[clubSlug]/page.tsx`) with the real Dashboard.

## Context

The design reference (`/Users/user/Documents/projects/gaafd/README.md` + `design/GaafD.dc.html`, screenshot `screenshots/01-dashboard.png`) specifies a Dashboard with: a 4-card KPI row, a 7-day "tokens dispensed" bar chart, a low-stock alerts panel, and a recent-activity feed mixing dispense/donation/member/stock events.

**Schema gap:** the current schema (phases 0-4) has no table recording dispense transactions — `inventory_moves` tracks stock deltas but has no `member_id` or token amount, so there is no way to compute "tokens dispensed today," the 7-day chart, or dispense-type activity events. This gap also blocks the future Dispensing/POS and Member Detail (token ledger) screens; it is not Dashboard-specific and is not being solved here.

**Decision (user-approved):** ship a real, partial Dashboard now. Every card backed by data that exists today (members, donations, products/stock) is fully real. Cards that need the token ledger are honest placeholders that will start working automatically once Dispensing/POS ships later — no rework required on this screen when that happens.

Also approved: no header search box, no "+ New dispense" button (neither has a real destination yet) — header is title + subtitle only.

## Data Layer

### `src/lib/format.ts` (new, pure functions, no Supabase — unit tested)

```ts
export function formatRand(amount: number): string;
// e.g. formatRand(6340) -> "R 6,340"

export function formatRelativeTime(timestamp: string, now?: Date): string;
// "just now" | "{n}m" | "{n}h" | "{n}d" — mirrors the design mock's "2m"/"11m"/"1h" style.
// `now` param exists purely so tests can pass a fixed clock instead of Date.now().

export function sastDayRange(daysAgo: number): { start: string; end: string };
// Returns the [start, end) ISO-8601 UTC instants bounding a South African
// calendar day (SAST = UTC+2, no DST) that is `daysAgo` days before today.
// daysAgo=0 -> today, daysAgo=1 -> yesterday. Used for "today"/"yesterday"
// boundaries so they match SA business days, not UTC midnight.

export function sastMonthStart(): string;
// ISO-8601 UTC instant for the first of the current month at 00:00 SAST.
```

### `src/lib/dashboard.ts` (new, Supabase-backed — integration tested against the live project)

```ts
export type DashboardKpis = {
  activeMembers: number;
  newMembersThisMonth: number;
  donationsTodayRand: number;
  donationsDelta: { text: string; positive: boolean } | null;
  lowStockCount: number;
};

export async function getDashboardKpis(
  supabase: SupabaseClient,
  clubId: string,
): Promise<DashboardKpis>;

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
): Promise<LowStockAlert[]>;
// Products where derived stock (product_stock view) <= 8, active only,
// sorted lowest-stock-first. Threshold is a constant (LOW_STOCK_THRESHOLD = 8)
// matching the design mock; revisit if Products ever gets a configurable
// per-product reorder point.

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
): Promise<ActivityItem[]>;
// Fetches recent donations (joined to members for the name) and recent
// member registrations (members.joined_at as the event time — the moment
// Step 1 creates the row, not when they later sign), merges by timestamp
// descending, returns the newest `limit`.
```

**Implementation notes:**
- `getDashboardKpis`'s donation delta: if yesterday's total was 0 and today's is > 0, show `{ text: "New today", positive: true }`; if both are 0, `null` (card shows no delta line); otherwise `text` is `"▲ {pct}% vs yesterday"` (today ≥ yesterday) or `"▼ {pct}% vs yesterday"` (today < yesterday), `pct` rounded to the nearest whole percent of `|today - yesterday| / yesterday`, `positive` set by the same comparison. The arrow lives inside `text`; `positive` only drives the color (green/red) the UI applies.
- `getLowStockAlerts` does two queries (products, then `product_stock`) and joins in JS — `product_stock` is a view without a real FK Postgres/PostgREST can use for embedding, so a single embedded query isn't reliable here. `donations` embedding `members(first,last)` in `getRecentActivity` DOES use a real FK and can be a single embedded query.
- All three functions take `clubId` as a plain parameter and rely on RLS as the enforcement boundary (established pattern in `contracts.ts`/`members.ts`) — no additional defense-in-depth check needed here since none of these are writes and RLS already scopes every table involved.

## Screen

### `src/app/[clubSlug]/page.tsx` (rewritten Server Component)

- `resolveClubAccess(supabase, clubSlug)` + `notFound()` if null (same as every other club route — yes, this duplicates the layout's own check; that's the established, deliberate pattern from phase 4).
- Runs `getDashboardKpis`, `getLowStockAlerts(..., 5)`, `getRecentActivity(..., 8)` via `Promise.all`.
- Renders `<DashboardHeader clubName={access.name} />` then the layout below.

### `src/app/[clubSlug]/dashboard-header.tsx` (new, tiny Client Component)

Same shape as phase 4's `success-header.tsx`: calls `usePageHeader({ title: "Dashboard", subtitle: `${clubName} · today` })`, returns `null`.

### Layout (all server-rendered, no client interactivity needed — no forms/buttons on this screen)

1. **KPI row** — 4 cards, `grid-cols-4`, matching the mock's card shell (`rounded-card border border-border bg-card`):
   - Active members — value = `activeMembers`, delta = `{newMembersThisMonth} new this month` (muted color, no arrow).
   - Donations today — value = `formatRand(donationsTodayRand)`, delta = `donationsDelta` if present (green ▲ / red ▼ / "New today"), else no delta line.
   - Low-stock items — value = `lowStockCount`, delta = `"needs reorder"` (red) if `lowStockCount > 0`, else `"all stocked"` (muted).
   - Tokens dispensed today — value = `"—"`, delta = `"Available once Dispensing ships"` (muted). Same card position/label as the mock, so no relayout is needed when this becomes real later.

2. **Two-column row**, `grid-cols-[1.6fr_1fr]`:
   - Left: "Tokens dispensed · last 7 days" card, heading unchanged from the mock, body replaced with a centered placeholder: "No dispensing activity yet — this fills in once the Dispensing screen is live."
   - Right: "Low stock alerts" card — lists `getLowStockAlerts` results (name, category badge, "{stock} {unit} left"), or "Nothing low on stock" centered if the list is empty.

3. **Recent activity** card, full width — renders `getRecentActivity` results:
   - Donation row: colored dot (`#6fbf82`), type label `DONATION`, text `"{memberName} donated ({method})"`, amount `+{tokensCredited}` in green, relative time.
   - Member row: colored dot (`#8ba6ff`), type label `MEMBER`, text `"New member registered · {code}"`, no amount, relative time.
   - Empty state if the list is empty: "No activity yet."

## Testing

- `tests/format.test.ts` — unit tests for `formatRand`, `formatRelativeTime` (fixed-clock cases: just now, 2m, 1h, 3d boundary), `sastDayRange`, `sastMonthStart`. No Supabase dependency, no live-project cost.
- `tests/dashboard.test.ts` — integration tests against the live project, reusing `tests/rls/fixtures.ts`'s `seedTenants`/`cleanupTenants`/`signInAs` (same convention as `tests/contracts.test.ts`/`tests/registration.test.ts`): seed a donation and a member registration for Club A, confirm `getDashboardKpis`/`getRecentActivity`/`getLowStockAlerts` return correct values scoped to Club A and do NOT leak Club B's seeded data (this phase touches read paths across multiple tenant-scoped tables, so a cross-tenant check here is warranted even though phase 1's RLS suite already proves the general policy — this specifically proves the new aggregation logic doesn't accidentally widen scope, e.g. by an unscoped query).
- UI (`page.tsx`, `dashboard-header.tsx`) verified via `tsc`/`build`/manual smoke test only, per this project's established convention (no component/DOM testing framework).

## Global Constraints

- Reuse `src/lib/supabase/server.ts`, `src/lib/auth/club-access.ts`'s `resolveClubAccess`, `src/lib/page-header-context.tsx`'s `usePageHeader` exactly as they exist — do not modify.
- Design tokens: use the `@theme`-mapped Tailwind utilities (`rounded-card`, `bg-card`, `border-border`, `text-destructive`, `font-heading`, `bg-primary`) matching every prior screen; arbitrary `text-[#hex]`/inline style only for tokens with no mapping (e.g. `#6fbf82`, `#8ba6ff` dot colors, which aren't in the token table as reusable utilities).
- `LOW_STOCK_THRESHOLD = 8` is a constant in `src/lib/dashboard.ts`, not a magic number inlined elsewhere.
- pnpm exclusively, Node via `.nvmrc`, commit messages plain/imperative, work on branch `master` directly (standing consent from prior phases).
