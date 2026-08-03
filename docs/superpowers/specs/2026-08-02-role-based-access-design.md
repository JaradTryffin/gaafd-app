# Role-Based Access Control — Design Spec

**Status:** Approved
**Scope:** Cross-cutting feature for GaafD, not tied to a single screen. Triggered by onboarding the first real trial customer (a shop, owner as admin, one floor employee as staff) — the owner explicitly needs the employee limited to day-to-day operational features, and a full codebase audit confirmed this restriction does not exist anywhere today: every signed-in `club_users` row, `staff` or `admin`, currently has 100% identical access everywhere, including zero server-side role checks on any mutation.

## Context

`club_users.role` (`check (role in ('staff','admin'))`) has existed since phase 1. `resolveClubAccess` (`src/lib/auth/club-access.ts`) already resolves and returns `role`, and `[clubSlug]/layout.tsx` already threads it into `ClubProvider`'s client context (`useClub().role`). The data plumbing exists; this feature is entirely about consuming that already-present field to gate navigation, page access, and mutations — the first time `role` is used for anything beyond cosmetic avatar labels.

## Access Matrix

| Screen | Admin | Staff |
|---|---|---|
| Dashboard | full | redirected to Dispensing |
| Dispensing | full | full |
| Members | full | full |
| Products | full CRUD | hidden from nav, `notFound()` if navigated to directly |
| Inventory | full | full (logging) |
| Donations | full | full |
| Till & Shifts | full (open/close day, workstations, everyone's shifts) | own clock-in/out only — cannot open or close the business day, cannot manage workstations, cannot see other staff's shifts or the KPI/reconciliation figures |
| Settings → Contract template | full | hidden from nav, `notFound()` if navigated to directly |

Opening the business day (setting the cash float) is admin-only, same as closing it — both are financial actions, not day-to-day operational ones. Staff clocks in once an admin has opened the day; if no day is open, staff sees a waiting message instead of an "open business day" control.

## Enforcement — Three Layers

Mirrors this project's established "server re-verifies, never trusts the client" convention (already used for tenant isolation everywhere) — hiding a nav link or redirecting a page is UX, not security. The real boundary is layer 3.

### 1. Sidebar nav filtering (cosmetic)

`src/components/app-shell/sidebar.tsx` already calls `useClub()`, which already exposes `role` — no new prop plumbing needed. `NAV_GROUPS` gets filtered by an `adminOnly?: boolean` flag on the `dashboard`, `products`, and `contract` entries before rendering, so staff never sees a dead link.

### 2. Page-level gate

- `src/app/[clubSlug]/page.tsx` (Dashboard): if `access.role !== "admin"`, `redirect(`/${clubSlug}/dispense`)` instead of rendering. A redirect, not `notFound()`, because Dashboard is the universal post-login landing page (every existing link — `select-club`, the sidebar club-switcher — points at `/${slug}` without knowing role in advance); redirecting at this single choke point means none of those links need to become role-aware themselves.
- `src/app/[clubSlug]/products/page.tsx`, `src/app/[clubSlug]/settings/contract/page.tsx`: if `access.role !== "admin"`, `notFound()` — matching the exact pattern already used when `resolveClubAccess` itself returns null.

### 3. Server-side authorization (the real boundary)

New file `src/lib/auth/require-role.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

export async function assertClubAdmin(supabase: SupabaseClient, clubId: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const { data: membership, error } = await supabase
    .from("club_users")
    .select("role")
    .eq("club_id", clubId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) throw error;
  if (!membership || membership.role !== "admin") {
    throw new Error("Admin access required");
  }
}
```

Matches the exact `auth.getUser()` → `club_users` lookup pattern already used repeatedly in this codebase (`createMovement`, `openBusinessDay`, etc.) — no new idiom introduced.

One line, `await assertClubAdmin(supabase, clubId);`, added at the top of exactly **7** existing functions (before any other work in each):

- `src/lib/products.ts`: `createProduct`, `updateProduct`, `deleteOrDeactivateProduct`
- `src/lib/contracts.ts`: `saveContractTemplate` only — `resetContractTemplate` already delegates to `saveContractTemplate` internally (`contracts.ts:183`), so it inherits the check for free; adding a second explicit call there would be redundant.
- `src/lib/till.ts`: `openBusinessDay`, `closeBusinessDay`, `createWorkstation`

Every `actions.ts` in this codebase already wraps its data-layer call in try/catch and returns `{ok:false,error}` on any thrown error — `assertClubAdmin`'s thrown `Error("Admin access required")` flows through that existing mechanism automatically. No `actions.ts` file needs to change.

Explicitly **not** gated: `getProducts`/`hasProductHistory` (products.ts — staff's Dispensing screen needs product reads), `getOrCreateContractTemplate` (read, also used by the member-signing flow which staff needs), `signContract` (staff registers/signs up new members), `clockIn`/`clockOut` (staff self-service), all read functions in `till.ts`.

## Till & Shifts Staff View

New component `src/app/[clubSlug]/till/staff-clock-panel.tsx` — just a clock-in/out control, nothing else: no KPI cards, no shifts table, no workstations panel, no close-day button.

`till/page.tsx` branches on `access.role`. For staff, it sends a minimal payload — not just a UI that hides fields, but data that's never fetched/sent to their browser at all:
- `isDayOpen: boolean` (derived from `getOpenBusinessDay`'s result, not the full `BusinessDay` object — staff has no reason to see the float or `openedByEmail`)
- their own open shift only, if any (found server-side via `getShiftsForDay` + filtering by `staffEmail === user.email`, so the full shift list — everyone else's clock times and cash-out amounts — never reaches a staff client)
- `workstations` (needed for the clock-in workstation picker — no financial data in this list, safe to pass through unfiltered)

The clock-in/out control's JSX/state (~40 lines: workstation picker, cash-out draft input, clock in/out buttons) is **deliberately duplicated** between `till-panel.tsx` (admin) and `staff-clock-panel.tsx` (staff) rather than extracted into a shared component. It's small enough that a shared abstraction would cost more in indirection than it saves, and the two call sites have different surrounding contexts (admin's is one region of a larger dashboard; staff's is the entire page) — matches this project's YAGNI stance on premature abstraction.

## Testing

Extends three existing test files (not new files), each gaining a locally-seeded `role: 'staff'` user for club A — mirroring the precedent `tests/till.test.ts` already established for its own admin-vs-staff force-close test:

- `tests/products.test.ts`: staff calling `createProduct`/`updateProduct`/`deleteOrDeactivateProduct` is rejected; admin still succeeds (regression check on existing passing tests).
- `tests/contracts.test.ts`: staff calling `saveContractTemplate` is rejected; admin still succeeds. (`resetContractTemplate` inherits the same check by delegation, so one test covering `saveContractTemplate` is sufficient — no separate `resetContractTemplate`-specific rejection test needed.)
- `tests/till.test.ts`: staff calling `openBusinessDay`/`closeBusinessDay`/`createWorkstation` is rejected; admin still succeeds. (This file already has a locally-seeded staff user from the force-close test — reuse it rather than seeding a second one.)

UI verified via `tsc`/`build`/manual smoke test only, per this project's established convention — specifically: log in as the demo admin, confirm all 8 screens and full Till dashboard are visible; log in as a staff-role user (create one via the existing `inviteStaffToClub` flow or a direct `club_users` insert against the demo club for testing purposes), confirm Dashboard redirects to Dispensing, Products/Contract-template links are absent from the sidebar and `notFound()` on direct navigation, and Till shows only the clock-in/out control.

## Global Constraints

- This plan explicitly **modifies** `src/lib/products.ts`, `src/lib/contracts.ts`, `src/lib/till.ts` (adding `assertClubAdmin` calls) and `src/components/app-shell/sidebar.tsx` (nav filtering) — unlike every prior plan's "reuse exactly as-is" instruction, modifying these three library files and the sidebar is this feature's entire purpose.
- Reuse `src/lib/auth/club-access.ts`'s `resolveClubAccess` and `src/lib/club-context.tsx`'s `useClub` exactly as they exist — both already expose `role`, neither needs modification.
- No PostgREST relation embedding anywhere.
- No shadcn/`@base-ui/react` components — hand-rolled Tailwind, matching every prior screen.
- Every labeled form field needs `htmlFor`/`id` pairing.
- pnpm exclusively, Node via `.nvmrc`, commit messages plain/imperative, work on branch `master` directly (standing consent from all prior phases).
