# Till & Shifts Screen — Design Spec

**Status:** Approved
**Scope:** Phase 5, next screen for GaafD (South African cannabis social club SaaS). Adds `/[clubSlug]/till` — currently unbuilt (sidebar's "Till & shifts" link 404s today).

## Context

Design reference: `/Users/user/Documents/projects/gaafd/README.md` (§13 "Till / Shift" — sparse: "3 KPI cards (shift totals) + shift management"), `design/GaafD.dc.html` lines 691-712 (the mock markup). No screenshot exists for this screen.

The mock is entirely static hardcoded data — 3 KPI cards (business day status, initial float tied to a specific till, cash donations vs "expected in drawer"), a "Shifts today" table, a "Workstations" panel, and a "Close business day" button whose only behavior is flashing a toast. Nothing is wired to real state, and nothing in the schema supports any of this yet — no `shifts`, `workstations`, or business-day concept exists. This is a bigger design surface than prior screens for that reason: there's copy and layout to transcribe, but no real data model to lift from the mock.

Two simplifications from the mock, decided during brainstorming:
- **One shared cash float per business day**, not per-till. The mock's "Initial float · Till A – front desk" implies per-till floats; a real build treats the float as club-wide (matches how a small single-drawer club actually operates), so workstations become a simple named list for shift assignment/display, not a separate financial unit.
- **Cash reconciliation is real, not decorative.** This app's dispensing is token-based, not cash-based — the only real physical-cash-in event is a `Cash`-method donation (already built). "Expected in drawer" = `initial_float + sum(today's Cash donations)`.

## Schema

New migration, three tables:

```sql
create table business_days (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  initial_float numeric(10,2) not null,
  opened_at timestamptz not null default now(),
  opened_by uuid references club_users(id) on delete set null,
  opened_by_email text not null,
  closed_at timestamptz,
  closed_by uuid references club_users(id) on delete set null,
  closed_by_email text,
  cash_counted numeric(10,2),
  status text not null default 'open' check (status in ('open','closed'))
);
create index business_days_club_id_idx on business_days(club_id);
-- Only one open business day per club at a time. This is the concurrency
-- guard: two people racing to open a day both attempt an insert, Postgres
-- rejects the second on the unique violation -- no function/lock needed.
create unique index business_days_one_open_per_club on business_days(club_id) where status = 'open';

create table workstations (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index workstations_club_id_idx on workstations(club_id);

create table shifts (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  business_day_id uuid not null references business_days(id) on delete cascade,
  staff_id uuid references club_users(id) on delete set null,
  staff_email text not null,
  workstation_id uuid references workstations(id) on delete set null,
  clock_in timestamptz not null default now(),
  clock_out timestamptz,
  cash_out numeric(10,2),
  force_closed boolean not null default false
);
create index shifts_club_id_idx on shifts(club_id);
create index shifts_business_day_id_idx on shifts(business_day_id);
```

`staff_email` snapshots at clock-in time, matching the exact pattern already established by `inventory_moves.staff_email` (avoids needing a cross-user `auth.users`/`club_users` read, which RLS doesn't allow anyway). `force_closed` records whether an admin closed this shift on someone else's behalf (for the shifts table's own honesty — a staff member's own clock-out vs an admin override are different events worth being able to tell apart later).

Workstations have no `has_till` distinction — every workstation IS a till in this simplified model (per the "one shared float" decision above). No delete — same soft-deactivate convention as Products (`active` boolean), since a workstation could be referenced by historical shifts.

## RLS

This is the first screen where rows genuinely get UPDATEd after creation (clock-out, business-day close) — every prior transactional screen (`donations`, `inventory_moves`, `dispense_orders`, `signed_contracts`) is append-only by design. `business_days` and `shifts` need real UPDATE policies, not just insert/select.

```sql
alter table business_days enable row level security;

create policy business_days_select on business_days for select to authenticated
  using (club_id in (select my_club_ids()));

create policy business_days_insert on business_days for insert to authenticated
  with check (club_id in (select my_club_ids()));

-- Only used by close_business_day() (below), which runs security invoker --
-- this UPDATE policy is what actually authorizes the write.
create policy business_days_update on business_days for update to authenticated
  using (club_id in (select my_club_ids()))
  with check (club_id in (select my_club_ids()));

alter table workstations enable row level security;

create policy workstations_select on workstations for select to authenticated
  using (club_id in (select my_club_ids()));

create policy workstations_insert on workstations for insert to authenticated
  with check (club_id in (select my_club_ids()));

create policy workstations_update on workstations for update to authenticated
  using (club_id in (select my_club_ids()))
  with check (club_id in (select my_club_ids()));

alter table shifts enable row level security;

create policy shifts_select on shifts for select to authenticated
  using (club_id in (select my_club_ids()));

create policy shifts_insert on shifts for insert to authenticated
  with check (club_id in (select my_club_ids()));

-- A shift can be updated (clocked out) by the staff member who owns it,
-- or by any admin in that club (force-close). Both branches only ever
-- read the CALLER's own club_users row (filtered by user_id = auth.uid()),
-- which club_users_select_own already permits -- no new helper function
-- or schema change needed.
create policy shifts_update on shifts for update to authenticated
  using (
    club_id in (select my_club_ids())
    and (
      staff_id = (select id from club_users where user_id = auth.uid() and club_id = shifts.club_id)
      or exists (select 1 from club_users where user_id = auth.uid() and club_id = shifts.club_id and role = 'admin')
    )
  )
  with check (
    club_id in (select my_club_ids())
    and (
      staff_id = (select id from club_users where user_id = auth.uid() and club_id = shifts.club_id)
      or exists (select 1 from club_users where user_id = auth.uid() and club_id = shifts.club_id and role = 'admin')
    )
  );
```

No `is_platform()` grant on any of the three — same exclusion already applied to `members`/`signed_contracts`/`dispense_orders` (staff shift and cash-handling records are at least as sensitive).

## Functions

Two, `security invoker`, same atomic-transaction pattern as `record_donation`/`create_dispense_order`.

Neither function reads `auth.users` directly — this codebase has never queried that table in SQL (grep of every existing migration confirms it), and Supabase's default grants don't give the `authenticated` role read access to it; every existing staff-email snapshot (`inventory_moves.staff_email`) is instead sourced client-side via `supabase.auth.getUser()`, matching how the JS Auth client (not a raw table grant) resolves it. Both functions below take the caller's email as a plain parameter for the same reason.

```sql
create or replace function clock_in(
  p_club_id uuid,
  p_workstation_id uuid,
  p_staff_email text
)
returns shifts
language plpgsql
security invoker
as $$
declare
  v_staff_id uuid;
  v_business_day_id uuid;
  v_shift shifts;
begin
  select cu.id into v_staff_id
  from club_users cu
  where cu.club_id = p_club_id and cu.user_id = auth.uid();
  if v_staff_id is null then
    raise exception 'Not a member of this club';
  end if;

  if exists (
    select 1 from shifts
    where club_id = p_club_id and staff_id = v_staff_id and clock_out is null
  ) then
    raise exception 'You already have an open shift';
  end if;

  select id into v_business_day_id
  from business_days
  where club_id = p_club_id and status = 'open';
  if v_business_day_id is null then
    raise exception 'No business day is open';
  end if;

  if p_workstation_id is not null and not exists (
    select 1 from workstations where id = p_workstation_id and club_id = p_club_id
  ) then
    raise exception 'Workstation not found in this club';
  end if;

  insert into shifts (club_id, business_day_id, staff_id, staff_email, workstation_id)
  values (p_club_id, v_business_day_id, v_staff_id, p_staff_email, p_workstation_id)
  returning * into v_shift;

  return v_shift;
end;
$$;

create or replace function close_business_day(
  p_club_id uuid,
  p_business_day_id uuid,
  p_staff_email text
)
returns business_days
language plpgsql
security invoker
as $$
declare
  v_open_count integer;
  v_cash_counted numeric(10,2);
  v_staff_id uuid;
  v_day business_days;
begin
  select cu.id into v_staff_id
  from club_users cu
  where cu.club_id = p_club_id and cu.user_id = auth.uid();
  if v_staff_id is null then
    raise exception 'Not a member of this club';
  end if;

  if not exists (
    select 1 from business_days where id = p_business_day_id and club_id = p_club_id and status = 'open'
  ) then
    raise exception 'Business day not found or already closed';
  end if;

  select count(*) into v_open_count
  from shifts
  where business_day_id = p_business_day_id and clock_out is null;
  if v_open_count > 0 then
    raise exception 'Cannot close: % shift(s) still open', v_open_count;
  end if;

  select coalesce(sum(cash_out), 0) into v_cash_counted
  from shifts
  where business_day_id = p_business_day_id;

  update business_days
  set status = 'closed', closed_at = now(), closed_by = v_staff_id,
      closed_by_email = p_staff_email, cash_counted = v_cash_counted
  where id = p_business_day_id
  returning * into v_day;

  return v_day;
end;
$$;
```

Clock-out (including force-close) and opening a business day are plain RLS-gated table writes handled entirely in the data layer below — single-row operations, no multi-step check-then-write, so no function is needed for them.

## Data Layer

### `src/lib/till.ts` (new)

```ts
export type BusinessDay = {
  id: string;
  initialFloat: number;
  openedAt: string;
  openedByEmail: string;
  closedAt: string | null;
  closedByEmail: string | null;
  cashCounted: number | null;
  status: "open" | "closed";
};

export type Workstation = {
  id: string;
  name: string;
  active: boolean;
};

export type Shift = {
  id: string;
  staffEmail: string;
  workstationId: string | null;
  workstationName: string | null;
  clockIn: string;
  clockOut: string | null;
  cashOut: number | null;
  status: "open" | "closed";
};

export async function getOpenBusinessDay(supabase: SupabaseClient, clubId: string): Promise<BusinessDay | null>;
export async function getWorkstations(supabase: SupabaseClient, clubId: string): Promise<Workstation[]>;
export async function getShiftsForDay(supabase: SupabaseClient, clubId: string, businessDayId: string): Promise<Shift[]>;
export async function getCashDonationsToday(supabase: SupabaseClient, clubId: string): Promise<number>;

export async function openBusinessDay(supabase: SupabaseClient, clubId: string, initialFloat: number): Promise<BusinessDay>;
export async function clockIn(supabase: SupabaseClient, clubId: string, workstationId: string | null): Promise<Shift>;
export async function clockOut(supabase: SupabaseClient, shiftId: string, cashOut: number, isForceClose: boolean): Promise<Shift>;
export async function closeBusinessDay(supabase: SupabaseClient, clubId: string, businessDayId: string): Promise<BusinessDay>;
export async function createWorkstation(supabase: SupabaseClient, clubId: string, name: string): Promise<Workstation>;
```

- **`getOpenBusinessDay`**: `.eq("status", "open").maybeSingle()` — returns `null` when no day is open (the screen's empty-state trigger).
- **`getCashDonationsToday`**: new function here (not added to `donations.ts`, which stays untouched per the global constraints below) — same `sastDayRange(0)` filter as `getTodaysDonations`, but `.eq("method", "Cash")` and summed, returning a single number.
- **`getShiftsForDay`**: joins in staff/workstation display data via the same two-sequential-queries-plus-map pattern used everywhere else in this codebase (no PostgREST embedding) — `staff_email` comes straight off the row (no join needed), `workstationName` resolved via a `workstations` lookup map.
- **`clockIn`/`closeBusinessDay`**: call the two RPCs above, single-composite-row return shape (same non-array handling as `recordDonation`/`createDispenseOrder`). Both resolve the caller's email via `supabase.auth.getUser()` client-side and pass it as `p_staff_email`, matching `inventory.ts`'s existing `user.email ?? null` pattern — the functions never query `auth.users` directly (see the Functions section above for why).
- **`clockOut`**: plain `.update({ clock_out, cash_out, force_closed: isForceClose }).eq("id", shiftId).is("clock_out", null)` — the `.is("clock_out", null)` guard prevents double-closing a shift that's already closed; RLS enforces who's allowed to touch the row at all (self or admin).
- **`openBusinessDay`/`createWorkstation`**: plain inserts. `openBusinessDay` resolves the caller's `club_users.id` and email the same way `createMovement` (`inventory.ts`) already does — `supabase.auth.getUser()` then a `club_users` membership lookup — before inserting `opened_by`/`opened_by_email`. It relies on the partial unique index to reject a second concurrent open attempt — the data layer surfaces that Postgres error as a normal thrown error, same `{ok:false,error}` handling as every other screen's server action.

## Screen

Same Server Component + Client Component split as every prior screen.

- `src/app/[clubSlug]/till/page.tsx` — `resolveClubAccess` + `notFound()`, fetches the open business day first; if one exists, fetches workstations/shifts/cash-donations-today in parallel alongside it, otherwise skips straight to rendering the empty state.
- `src/app/[clubSlug]/till/till-header.tsx` — title "Till & shifts", subtitle "Daily cash handling" (mock's own copy).
- `src/app/[clubSlug]/till/till-panel.tsx` — Client Component:
  - **No open business day**: a centered "Open business day" card — initial float amount input, "Open business day" button. Matches the honest-empty-state pattern already established at Dashboard for not-yet-real data.
  - **Open business day exists**: 3 KPI cards — Business day (status "Open · {date}", "Opened {time} by {email}"), Initial float (amount, no till subtitle since float is club-wide now), Cash donations today (amount, "Expected in drawer: {float + cashDonations}"). Below: "Shifts today" table (staff email, clock-in time, clock-out time or "—", cash-out or "—", status pill open/closed) and a "Workstations" side panel (name + Idle/In use pill derived from whether an open shift references that workstation, small inline "+ Add workstation" name input). A clock-in/clock-out control lives in the header area: if the signed-in user has no open shift, a "Clock in" button (workstation picker, optional); if they do, a "Clock out" button (cash-out amount input). "Close business day" button at the bottom of the Workstations panel — disabled with a tooltip-style message while any shift is open, and on success shows the real reconciliation (counted vs expected, variance) instead of the mock's fake toast.
  - Admin-only force-close: any open shift row in the table gets a small "Force close" action, visible to everyone in the UI (this app has no existing role-gated UI anywhere, so consistent with that convention) but only actually succeeds for admins — RLS is the real enforcement, the UI doesn't pre-filter by role. A non-admin attempting it gets the RPC/RLS error surfaced as a normal toast, same as every other permission failure in this app.

## Testing

- `tests/till.test.ts`, live Supabase, reusing `tests/rls/fixtures.ts`'s `seedTenants`/`cleanupTenants`/`signInAs`. Note: the shared fixture only ever creates `role: 'admin'` club users (confirmed in `fixtures.ts`) — there's no staff-role user to test the "non-admin cannot force-close" case against. Follow `dispensing.test.ts`'s precedent (which already seeds its own product/member locally instead of relying solely on the shared fixture): add a local helper that creates a second auth user + a `role: 'staff'` `club_users` row for club A via the admin client, signs in as them, and uses that session for the non-admin force-close rejection test.
  Covers: opening a business day, then a second concurrent open attempt for the same club fails (unique index); clocking in creates a shift tied to the open day, a second clock-in for the same staff member while the first is still open is rejected; clocking out sets `clock_out`/`cash_out` and the shift no longer counts as open; an admin can force-close another staff member's shift, a non-admin staff member cannot (cross-role RLS check, using the locally-seeded staff user above); closing a business day with an open shift still present is rejected; closing succeeds once all shifts are closed and `cash_counted` equals the sum of all shifts' `cash_out`; cross-club isolation on all three tables (a club B user cannot see or act on club A's business day/shifts/workstations).
- UI verified via `tsc`/`build`/manual smoke test only, per this project's established convention.

## Global Constraints

- Reuse `src/lib/supabase/server.ts`, `src/lib/auth/club-access.ts`'s `resolveClubAccess`, `src/lib/page-header-context.tsx`'s `usePageHeader`, `src/lib/toast-context.tsx`'s `useToast`, `src/lib/format.ts`'s `sastDayRange`/`formatRand`/`formatRelativeTime` exactly as they exist — do not modify any of them. Do not modify `src/lib/donations.ts` — `getCashDonationsToday` is new code in `till.ts`, not an addition to the donations module.
- No PostgREST relation embedding anywhere.
- No shadcn/`@base-ui/react` components — hand-rolled Tailwind markup, matching every prior screen.
- Every labeled form field needs `htmlFor`/`id` pairing.
- Migration files follow the existing `YYYYMMDDHHMMSS_description.sql` naming, applied via `supabase db push --linked` against the live linked project (ref `inlseklfbptgjketdnpe`).
- pnpm exclusively, Node via `.nvmrc`, commit messages plain/imperative, work on branch `master` directly (standing consent from all prior phases).
