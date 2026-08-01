# Till & Shifts Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `/[clubSlug]/till` — a real business-day/cash-handling screen: open a business day with a starting float, staff clock in/out with a cash-out amount, an admin can force-close a forgotten shift, and closing the day computes a real cash reconciliation against today's `Cash`-method donations.

**Architecture:** Three new tables (`business_days`, `workstations`, `shifts`) with RLS — the first tables in this project that need real UPDATE policies, since every prior transactional table (`donations`, `inventory_moves`, `dispense_orders`, `signed_contracts`) is append-only. Two `security invoker` functions (`clock_in`, `close_business_day`) handle the two multi-step check-then-write operations; everything else (clock-out, opening a day, adding a workstation) is a plain RLS-gated table write. Split into 4 tasks matching the Dispensing plan's shape: schema+RLS, functions, data layer + tests, UI — each migration concern gets its own review gate.

**Tech Stack:** Next.js App Router, TypeScript, Supabase JS client (`.rpc()` and `.from()`), Vitest.

## Global Constraints

- Reuse `src/lib/supabase/server.ts`, `src/lib/auth/club-access.ts`'s `resolveClubAccess`, `src/lib/page-header-context.tsx`'s `usePageHeader`, `src/lib/toast-context.tsx`'s `useToast`, `src/lib/format.ts`'s `sastDayRange`/`formatRand` exactly as they exist — do not modify any of them. Do not modify `src/lib/donations.ts`.
- No PostgREST relation embedding anywhere.
- No shadcn/`@base-ui/react` components — hand-rolled Tailwind markup, matching every prior screen.
- Every labeled form field needs `htmlFor`/`id` pairing.
- Migration files follow the existing `YYYYMMDDHHMMSS_description.sql` naming, applied via `supabase db push --linked` against the live linked project (ref `inlseklfbptgjketdnpe`).
- pnpm exclusively, Node via `.nvmrc` (run `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use` before any command — this environment's `pnpm`/corepack shim breaks under the nvm-default Node version otherwise; fall back to `node_modules/.bin/tsc`/`node_modules/.bin/next`/`node_modules/.bin/vitest` directly if it still fails after `nvm use`).
- Commit messages plain, imperative. Work on branch `master` directly (standing consent from all prior phases).
- `ClubAccess` (`src/lib/auth/club-access.ts`) fields used: `clubId, slug, name, role`. `MemberListRow`/`Product` are not used by this feature.

---

### Task 1: Migration — schema + RLS for `business_days`, `workstations`, `shifts`

**Files:**
- Create: `supabase/migrations/20260801140000_till_shifts_schema.sql`

**Interfaces:**
- Produces: the `business_days`, `workstations`, `shifts` tables — consumed by Task 2's functions and Task 3's data layer.

No application code in this task — pure schema, verified against the live project directly.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260801140000_till_shifts_schema.sql`:

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

alter table business_days enable row level security;

create policy business_days_select on business_days for select to authenticated
  using (club_id in (select my_club_ids()));

create policy business_days_insert on business_days for insert to authenticated
  with check (club_id in (select my_club_ids()));

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

- [ ] **Step 2: Apply the migration**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use && supabase db push --linked`
Expected: lists the new migration, applies it, ends with `Finished supabase db push.`

- [ ] **Step 3: Verify nothing is left pending**

Run: `supabase db push --linked --dry-run`
Expected: no pending migrations listed.

- [ ] **Step 4: Verify schema against the live project**

```sql
select column_name, data_type, is_nullable from information_schema.columns
where table_name = 'business_days' order by ordinal_position;
```
Expected: `id, club_id, initial_float, opened_at, opened_by, opened_by_email, closed_at, closed_by, closed_by_email, cash_counted, status` — `club_id`, `initial_float`, `opened_at`, `opened_by_email`, `status` `NOT NULL`; the rest nullable.

```sql
select column_name, data_type, is_nullable from information_schema.columns
where table_name = 'workstations' order by ordinal_position;
```
Expected: `id, club_id, name, active, created_at` — `club_id`, `name`, `active`, `created_at` `NOT NULL`.

```sql
select column_name, data_type, is_nullable from information_schema.columns
where table_name = 'shifts' order by ordinal_position;
```
Expected: `id, club_id, business_day_id, staff_id, staff_email, workstation_id, clock_in, clock_out, cash_out, force_closed` — `club_id`, `business_day_id`, `staff_email`, `clock_in`, `force_closed` `NOT NULL`; `staff_id`, `workstation_id`, `clock_out`, `cash_out` nullable.

- [ ] **Step 5: Verify the partial unique index**

```sql
select indexname, indexdef from pg_indexes where tablename = 'business_days';
```
Expected: `business_days_club_id_idx` and `business_days_one_open_per_club` — the second one's `indexdef` contains `WHERE (status = 'open'::text)`.

- [ ] **Step 6: Verify RLS policies**

```sql
select tablename, policyname, cmd from pg_policies
where schemaname = 'public' and tablename in ('business_days', 'workstations', 'shifts')
order by tablename, cmd;
```
Expected: exactly 3 rows per table — SELECT, INSERT, UPDATE. No DELETE policy on any of the three, no policy referencing `is_platform()`.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260801140000_till_shifts_schema.sql
git commit -m "Add business_days, workstations, and shifts tables with RLS"
```

---

### Task 2: Migration — `clock_in` and `close_business_day` functions

**Files:**
- Create: `supabase/migrations/20260801140100_till_shifts_functions.sql`

**Interfaces:**
- Consumes: Task 1's three tables.
- Produces: `clock_in(p_club_id uuid, p_workstation_id uuid, p_staff_email text) returns shifts` and `close_business_day(p_club_id uuid, p_business_day_id uuid, p_staff_email text) returns business_days` — both consumed by Task 3 via `supabase.rpc(...)`.

No application code in this task.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260801140100_till_shifts_functions.sql`:

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

- [ ] **Step 2: Apply the migration**

Run: `supabase db push --linked`
Expected: applies cleanly.

- [ ] **Step 3: Verify nothing is left pending**

Run: `supabase db push --linked --dry-run`
Expected: no pending migrations listed.

- [ ] **Step 4: Verify the functions exist and are `security invoker`**

```sql
select proname, prosecdef from pg_proc where proname in ('clock_in', 'close_business_day');
```
Expected: two rows, both `prosecdef = false` (invoker, not definer).

- [ ] **Step 5: Scoped manual E2E smoke test**

This is a scoped smoke test — Task 3's automated suite covers the full correctness matrix (rejection paths, cross-club, cross-role) exhaustively. Using the service-role admin client, create a throwaway club with one auth user (role `admin` in `club_users`) — mirror `tests/rls/fixtures.ts`'s `seedClub`'s club + admin-user + membership portion, not the shared fixture function itself. Sign in as that user with the anon client for the calls below (functions run `security invoker`, so they must be called as an authenticated session, not the service-role client).

(a) Call `clock_in` before any business day is open. Confirm it raises `'No business day is open'`.

(b) Insert a `business_days` row directly via the admin client (`initial_float: 1000`, `status: 'open'`) to simulate an already-open day (Task 3 will exercise the real `openBusinessDay` insert path — this step only needs a day to exist). Call `clock_in` with a null workstation. Confirm it returns a `shifts` row with `clock_out` null and `staff_email` matching what was passed.

(c) Call `clock_in` again as the same user. Confirm it raises `'You already have an open shift'`.

(d) Call `close_business_day` for that business day. Confirm it raises an exception mentioning the shift is still open (the `1 shift(s) still open` message).

(e) Update the shift directly via the admin client to set `clock_out = now()`, `cash_out = 250`. Call `close_business_day` again. Confirm it succeeds, returns `status: 'closed'`, `cash_counted: 250`.

Delete the throwaway club afterward (cascades to `club_users`, `business_days`, `workstations`, `shifts`).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260801140100_till_shifts_functions.sql
git commit -m "Add clock_in and close_business_day functions"
```

---

### Task 3: Till data layer + tests

**Files:**
- Create: `src/lib/till.ts`
- Test: `tests/till.test.ts`

**Interfaces:**
- Consumes: Task 2's `clock_in`/`close_business_day` RPCs, Task 1's tables.
- Produces: `BusinessDay`, `Workstation`, `Shift` types and `getOpenBusinessDay`, `getWorkstations`, `getShiftsForDay`, `getCashDonationsToday`, `openBusinessDay`, `clockIn`, `clockOut`, `closeBusinessDay`, `createWorkstation` — all consumed by Task 4's `actions.ts`.

- [ ] **Step 1: Write `src/lib/till.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { sastDayRange } from "@/lib/format";

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
  staffId: string | null;
  staffEmail: string;
  workstationId: string | null;
  workstationName: string | null;
  clockIn: string;
  clockOut: string | null;
  cashOut: number | null;
  status: "open" | "closed";
};

type BusinessDayRow = {
  id: string;
  initial_float: number;
  opened_at: string;
  opened_by_email: string;
  closed_at: string | null;
  closed_by_email: string | null;
  cash_counted: number | null;
  status: "open" | "closed";
};

const BUSINESS_DAY_COLUMNS =
  "id, initial_float, opened_at, opened_by_email, closed_at, closed_by_email, cash_counted, status";

function mapBusinessDay(row: BusinessDayRow): BusinessDay {
  return {
    id: row.id,
    initialFloat: Number(row.initial_float),
    openedAt: row.opened_at,
    openedByEmail: row.opened_by_email,
    closedAt: row.closed_at,
    closedByEmail: row.closed_by_email,
    cashCounted: row.cash_counted === null ? null : Number(row.cash_counted),
    status: row.status,
  };
}

export async function getOpenBusinessDay(supabase: SupabaseClient, clubId: string): Promise<BusinessDay | null> {
  const { data, error } = await supabase
    .from("business_days")
    .select(BUSINESS_DAY_COLUMNS)
    .eq("club_id", clubId)
    .eq("status", "open")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return mapBusinessDay(data as BusinessDayRow);
}

export async function getWorkstations(supabase: SupabaseClient, clubId: string): Promise<Workstation[]> {
  const { data, error } = await supabase
    .from("workstations")
    .select("id, name, active")
    .eq("club_id", clubId)
    .order("name", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    active: row.active as boolean,
  }));
}

type ShiftRow = {
  id: string;
  staff_id: string | null;
  staff_email: string;
  workstation_id: string | null;
  clock_in: string;
  clock_out: string | null;
  cash_out: number | null;
};

function mapShiftRow(row: ShiftRow, workstationName: string | null): Shift {
  return {
    id: row.id,
    staffId: row.staff_id,
    staffEmail: row.staff_email,
    workstationId: row.workstation_id,
    workstationName,
    clockIn: row.clock_in,
    clockOut: row.clock_out,
    cashOut: row.cash_out === null ? null : Number(row.cash_out),
    status: row.clock_out === null ? "open" : "closed",
  };
}

export async function getShiftsForDay(
  supabase: SupabaseClient,
  clubId: string,
  businessDayId: string,
): Promise<Shift[]> {
  const { data: rows, error } = await supabase
    .from("shifts")
    .select("id, staff_id, staff_email, workstation_id, clock_in, clock_out, cash_out")
    .eq("club_id", clubId)
    .eq("business_day_id", businessDayId)
    .order("clock_in", { ascending: false });
  if (error) throw error;

  const list = (rows ?? []) as ShiftRow[];
  if (list.length === 0) return [];

  const workstationIds = [
    ...new Set(list.map((r) => r.workstation_id).filter((id): id is string => id !== null)),
  ];
  let nameById = new Map<string, string>();
  if (workstationIds.length > 0) {
    const { data: workstations, error: wError } = await supabase
      .from("workstations")
      .select("id, name")
      .in("id", workstationIds);
    if (wError) throw wError;
    nameById = new Map((workstations ?? []).map((w) => [w.id as string, w.name as string]));
  }

  return list.map((row) =>
    mapShiftRow(row, row.workstation_id ? nameById.get(row.workstation_id) ?? "—" : null),
  );
}

export async function getCashDonationsToday(supabase: SupabaseClient, clubId: string): Promise<number> {
  const today = sastDayRange(0);
  const { data, error } = await supabase
    .from("donations")
    .select("amount_rand")
    .eq("club_id", clubId)
    .eq("method", "Cash")
    .gte("created_at", today.start)
    .lt("created_at", today.end);
  if (error) throw error;
  return (data ?? []).reduce((sum, row) => sum + Number(row.amount_rand), 0);
}

export async function openBusinessDay(
  supabase: SupabaseClient,
  clubId: string,
  initialFloat: number,
): Promise<BusinessDay> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const { data: membership, error: membershipError } = await supabase
    .from("club_users")
    .select("id")
    .eq("club_id", clubId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (membershipError) throw membershipError;
  if (!membership) throw new Error("Not a member of this club");

  const { data, error } = await supabase
    .from("business_days")
    .insert({
      club_id: clubId,
      initial_float: initialFloat,
      opened_by: membership.id,
      opened_by_email: user.email ?? "",
    })
    .select(BUSINESS_DAY_COLUMNS)
    .single();
  if (error) throw error;
  return mapBusinessDay(data as BusinessDayRow);
}

export async function createWorkstation(
  supabase: SupabaseClient,
  clubId: string,
  name: string,
): Promise<Workstation> {
  const { data, error } = await supabase
    .from("workstations")
    .insert({ club_id: clubId, name })
    .select("id, name, active")
    .single();
  if (error) throw error;
  return { id: data.id as string, name: data.name as string, active: data.active as boolean };
}

export async function clockIn(
  supabase: SupabaseClient,
  clubId: string,
  workstationId: string | null,
): Promise<Shift> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const { data, error } = await supabase.rpc("clock_in", {
    p_club_id: clubId,
    p_workstation_id: workstationId,
    p_staff_email: user.email ?? "",
  });
  if (error) throw error;

  const row = data as ShiftRow;
  let workstationName: string | null = null;
  if (row.workstation_id) {
    const { data: workstation } = await supabase
      .from("workstations")
      .select("name")
      .eq("id", row.workstation_id)
      .maybeSingle();
    workstationName = workstation?.name ?? null;
  }
  return mapShiftRow(row, workstationName);
}

export async function clockOut(
  supabase: SupabaseClient,
  shiftId: string,
  cashOut: number,
  isForceClose: boolean,
): Promise<Shift> {
  const { data, error } = await supabase
    .from("shifts")
    .update({ clock_out: new Date().toISOString(), cash_out: cashOut, force_closed: isForceClose })
    .eq("id", shiftId)
    .is("clock_out", null)
    .select("id, staff_id, staff_email, workstation_id, clock_in, clock_out, cash_out")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Shift not found, already closed, or you don't have permission to close it");

  const row = data as ShiftRow;
  let workstationName: string | null = null;
  if (row.workstation_id) {
    const { data: workstation } = await supabase
      .from("workstations")
      .select("name")
      .eq("id", row.workstation_id)
      .maybeSingle();
    workstationName = workstation?.name ?? null;
  }
  return mapShiftRow(row, workstationName);
}

export async function closeBusinessDay(
  supabase: SupabaseClient,
  clubId: string,
  businessDayId: string,
): Promise<BusinessDay> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const { data, error } = await supabase.rpc("close_business_day", {
    p_club_id: clubId,
    p_business_day_id: businessDayId,
    p_staff_email: user.email ?? "",
  });
  if (error) throw error;
  return mapBusinessDay(data as BusinessDayRow);
}
```

- [ ] **Step 2: Write `tests/till.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedTenants, cleanupTenants, signInAs, type SeededData } from "./rls/fixtures";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  openBusinessDay,
  clockIn,
  clockOut,
  closeBusinessDay,
  createWorkstation,
  getOpenBusinessDay,
  getShiftsForDay,
} from "@/lib/till";

let data: SeededData;
let clubAClient: SupabaseClient;
let clubBClient: SupabaseClient;
let staffClient: SupabaseClient;
let staffUserId: string;
const STAFF_PASSWORD = "Test-Password-123!";

beforeAll(async () => {
  data = await seedTenants();
  clubAClient = await signInAs(data.clubA.adminEmail, data.clubA.adminPassword);
  clubBClient = await signInAs(data.clubB.adminEmail, data.clubB.adminPassword);

  // The shared fixture only creates role: 'admin' club users. This
  // feature's cross-role RLS check (admin force-close vs. non-admin
  // rejected) needs a role: 'staff' identity, so seed one locally for
  // club A, matching dispensing.test.ts's precedent of local seeding for
  // scenarios the shared fixture doesn't cover.
  const admin = createAdminClient();
  const staffEmail = `till-staff-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const { data: staffAuth, error: staffAuthError } = await admin.auth.admin.createUser({
    email: staffEmail,
    password: STAFF_PASSWORD,
    email_confirm: true,
  });
  if (staffAuthError) throw staffAuthError;
  staffUserId = staffAuth.user.id;

  const { error: staffMembershipError } = await admin.from("club_users").insert({
    club_id: data.clubA.clubId,
    user_id: staffUserId,
    role: "staff",
  });
  if (staffMembershipError) throw staffMembershipError;

  staffClient = await signInAs(staffEmail, STAFF_PASSWORD);
}, 30000);

afterAll(async () => {
  const admin = createAdminClient();
  if (staffUserId) {
    await admin.auth.admin.deleteUser(staffUserId);
  }
  // clubs cascade-delete business_days/workstations/shifts (all
  // club_id -> clubs on delete cascade), so no separate cleanup needed
  // for rows created by the tests below.
  if (data) {
    await cleanupTenants(data);
  }
}, 30000);

describe("business day + shift lifecycle (club A)", () => {
  it("runs the full sequence: open, reject double-open, clock in/out, force-close, close day", async () => {
    const day = await openBusinessDay(clubAClient, data.clubA.clubId, 1500);
    expect(day.status).toBe("open");
    expect(day.initialFloat).toBe(1500);
    expect(day.openedByEmail).toBe(data.clubA.adminEmail);

    // Only one open business day per club at a time.
    await expect(openBusinessDay(clubAClient, data.clubA.clubId, 1000)).rejects.toThrow();

    const workstation = await createWorkstation(clubAClient, data.clubA.clubId, "Front desk");
    expect(workstation.name).toBe("Front desk");

    const staffShift = await clockIn(staffClient, data.clubA.clubId, workstation.id);
    expect(staffShift.status).toBe("open");
    expect(staffShift.staffEmail).toMatch(/^till-staff-.+@example\.test$/);
    expect(staffShift.workstationName).toBe("Front desk");

    // Same staff member can't clock in twice while already open.
    await expect(clockIn(staffClient, data.clubA.clubId, null)).rejects.toThrow();

    const adminShift = await clockIn(clubAClient, data.clubA.clubId, null);
    expect(adminShift.status).toBe("open");

    // Can't close the day while shifts are still open.
    await expect(closeBusinessDay(clubAClient, data.clubA.clubId, day.id)).rejects.toThrow();

    // A non-admin can't force-close someone else's shift — RLS matches
    // zero rows, which clockOut() surfaces as a thrown error.
    await expect(clockOut(staffClient, adminShift.id, 100, true)).rejects.toThrow();

    // An admin CAN force-close another staff member's shift.
    const forceClosed = await clockOut(clubAClient, staffShift.id, 300, true);
    expect(forceClosed.status).toBe("closed");
    expect(forceClosed.cashOut).toBe(300);

    // Admin clocks themselves out normally.
    const selfClosed = await clockOut(clubAClient, adminShift.id, 150, false);
    expect(selfClosed.status).toBe("closed");
    expect(selfClosed.cashOut).toBe(150);

    const closedDay = await closeBusinessDay(clubAClient, data.clubA.clubId, day.id);
    expect(closedDay.status).toBe("closed");
    expect(closedDay.cashCounted).toBe(450);

    const finalShifts = await getShiftsForDay(clubAClient, data.clubA.clubId, day.id);
    expect(finalShifts.every((s) => s.status === "closed")).toBe(true);
  });
});

describe("cross-club isolation", () => {
  it("prevents club A from seeing or acting on club B's business day/shifts", async () => {
    await openBusinessDay(clubBClient, data.clubB.clubId, 800);
    await createWorkstation(clubBClient, data.clubB.clubId, "Lounge");
    await clockIn(clubBClient, data.clubB.clubId, null);

    // club A's session querying club B's clubId sees nothing — RLS
    // filters the row out entirely, it's not an error, just absent.
    const seenByA = await getOpenBusinessDay(clubAClient, data.clubB.clubId);
    expect(seenByA).toBeNull();

    // club A has no club_users row for club B, so clock_in's own
    // membership check rejects it before any write.
    await expect(clockIn(clubAClient, data.clubB.clubId, null)).rejects.toThrow();

    // Club B's business day/shift/workstation are left open here —
    // cleanupTenants' club deletion cascades them away regardless of
    // status, so no explicit close/cleanup is needed in this test.
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use && node_modules/.bin/vitest run tests/till.test.ts`
Expected: 2 tests passed (one per `describe` block).

- [ ] **Step 4: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/till.ts tests/till.test.ts
git commit -m "Add till data layer with clock-in/out, business day, and workstation operations"
```

---

### Task 4: Till & shifts screen UI

**Files:**
- Create: `src/app/[clubSlug]/till/page.tsx`
- Create: `src/app/[clubSlug]/till/till-header.tsx`
- Create: `src/app/[clubSlug]/till/till-panel.tsx`
- Create: `src/app/[clubSlug]/till/actions.ts`

**Interfaces:**
- Consumes: Task 3's `till.ts` exports.
- Produces: the `/[clubSlug]/till` route (the sidebar already links here — `src/components/app-shell/sidebar.tsx:25` — no sidebar change needed).

- [ ] **Step 1: Write `src/app/[clubSlug]/till/actions.ts`**

```ts
"use server";

import { createClient } from "@/lib/supabase/server";
import {
  openBusinessDay,
  clockIn,
  clockOut,
  closeBusinessDay,
  createWorkstation,
  type BusinessDay,
  type Shift,
  type Workstation,
} from "@/lib/till";

export async function openBusinessDayAction(
  clubId: string,
  initialFloat: number,
): Promise<{ ok: true; businessDay: BusinessDay } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const businessDay = await openBusinessDay(supabase, clubId, initialFloat);
    return { ok: true, businessDay };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to open business day" };
  }
}

export async function clockInAction(
  clubId: string,
  workstationId: string | null,
): Promise<{ ok: true; shift: Shift } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const shift = await clockIn(supabase, clubId, workstationId);
    return { ok: true, shift };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to clock in" };
  }
}

export async function clockOutAction(
  shiftId: string,
  cashOut: number,
  isForceClose: boolean,
): Promise<{ ok: true; shift: Shift } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const shift = await clockOut(supabase, shiftId, cashOut, isForceClose);
    return { ok: true, shift };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to clock out" };
  }
}

export async function closeBusinessDayAction(
  clubId: string,
  businessDayId: string,
): Promise<{ ok: true; businessDay: BusinessDay } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const businessDay = await closeBusinessDay(supabase, clubId, businessDayId);
    return { ok: true, businessDay };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to close business day" };
  }
}

export async function createWorkstationAction(
  clubId: string,
  name: string,
): Promise<{ ok: true; workstation: Workstation } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const workstation = await createWorkstation(supabase, clubId, name);
    return { ok: true, workstation };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to add workstation" };
  }
}
```

- [ ] **Step 2: Write `src/app/[clubSlug]/till/till-header.tsx`**

```tsx
"use client";

import { usePageHeader } from "@/lib/page-header-context";

export function TillHeader() {
  usePageHeader({ title: "Till & shifts", subtitle: "Daily cash handling" });
  return null;
}
```

- [ ] **Step 3: Write `src/app/[clubSlug]/till/page.tsx`**

```tsx
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import { getOpenBusinessDay, getWorkstations, getShiftsForDay, getCashDonationsToday } from "@/lib/till";
import { TillHeader } from "./till-header";
import { TillPanel } from "./till-panel";

export default async function TillPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const supabase = await createClient();
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const businessDay = await getOpenBusinessDay(supabase, access.clubId);

  const [workstations, shifts, cashDonationsToday] = await Promise.all([
    getWorkstations(supabase, access.clubId),
    businessDay ? getShiftsForDay(supabase, access.clubId, businessDay.id) : Promise.resolve([]),
    getCashDonationsToday(supabase, access.clubId),
  ]);

  return (
    <>
      <TillHeader />
      <TillPanel
        clubId={access.clubId}
        currentUserEmail={user?.email ?? ""}
        businessDay={businessDay}
        workstations={workstations}
        shifts={shifts}
        cashDonationsToday={cashDonationsToday}
      />
    </>
  );
}
```

- [ ] **Step 4: Write `src/app/[clubSlug]/till/till-panel.tsx`**

```tsx
"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/lib/toast-context";
import { formatRand } from "@/lib/format";
import {
  openBusinessDayAction,
  clockInAction,
  clockOutAction,
  closeBusinessDayAction,
  createWorkstationAction,
} from "./actions";
import type { BusinessDay, Shift, Workstation } from "@/lib/till";

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" });
}

export function TillPanel({
  clubId,
  currentUserEmail,
  businessDay: initialBusinessDay,
  workstations: initialWorkstations,
  shifts: initialShifts,
  cashDonationsToday,
}: {
  clubId: string;
  currentUserEmail: string;
  businessDay: BusinessDay | null;
  workstations: Workstation[];
  shifts: Shift[];
  cashDonationsToday: number;
}) {
  const { showToast } = useToast();
  const [businessDay, setBusinessDay] = useState(initialBusinessDay);
  const [workstations, setWorkstations] = useState(initialWorkstations);
  const [shifts, setShifts] = useState(initialShifts);
  const [floatInput, setFloatInput] = useState("");
  const [workstationInput, setWorkstationInput] = useState("");
  const [newWorkstationName, setNewWorkstationName] = useState("");
  const [cashOutDrafts, setCashOutDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const myOpenShift = shifts.find((s) => s.staffEmail === currentUserEmail && s.status === "open");
  const openShiftsCount = shifts.filter((s) => s.status === "open").length;
  const expectedInDrawer = businessDay ? businessDay.initialFloat + cashDonationsToday : 0;

  function handleOpenDay() {
    setError(null);
    const amount = Number(floatInput);
    if (!floatInput || Number.isNaN(amount) || amount < 0) {
      setError("Enter a valid float amount");
      return;
    }
    startTransition(async () => {
      const result = await openBusinessDayAction(clubId, amount);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setBusinessDay(result.businessDay);
      setShifts([]);
      setFloatInput("");
      showToast("Business day opened");
    });
  }

  function handleClockIn() {
    setError(null);
    startTransition(async () => {
      const result = await clockInAction(clubId, workstationInput || null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setShifts((prev) => [result.shift, ...prev]);
      showToast("Clocked in");
    });
  }

  function handleClockOut(shift: Shift, isForceClose: boolean) {
    setError(null);
    const raw = cashOutDrafts[shift.id] ?? "";
    const amount = Number(raw);
    if (!raw || Number.isNaN(amount) || amount < 0) {
      setError("Enter a valid cash-out amount");
      return;
    }
    startTransition(async () => {
      const result = await clockOutAction(shift.id, amount, isForceClose);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setShifts((prev) => prev.map((s) => (s.id === result.shift.id ? result.shift : s)));
      showToast(isForceClose ? "Shift force-closed" : "Clocked out");
    });
  }

  function handleAddWorkstation() {
    setError(null);
    if (!newWorkstationName.trim()) {
      setError("Enter a workstation name");
      return;
    }
    startTransition(async () => {
      const result = await createWorkstationAction(clubId, newWorkstationName.trim());
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setWorkstations((prev) => [...prev, result.workstation]);
      setNewWorkstationName("");
    });
  }

  function handleCloseDay() {
    if (!businessDay) return;
    setError(null);
    startTransition(async () => {
      const result = await closeBusinessDayAction(clubId, businessDay.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const counted = result.businessDay.cashCounted ?? 0;
      const variance = counted - expectedInDrawer;
      setBusinessDay(result.businessDay);
      showToast(
        `Business day closed · counted ${formatRand(counted)}, expected ${formatRand(expectedInDrawer)} (${
          variance >= 0 ? "+" : ""
        }${formatRand(variance)})`,
      );
    });
  }

  if (!businessDay || businessDay.status === "closed") {
    return (
      <div className="flex min-h-[360px] items-center justify-center">
        <div className="w-full max-w-[380px] rounded-card border border-border bg-card p-6 text-center">
          <div className="mb-1 font-heading text-base font-semibold">
            {businessDay?.status === "closed" ? "Business day closed" : "No business day open"}
          </div>
          <p className="mb-4 text-[12.5px] text-[#6b6f66]">
            {businessDay?.status === "closed"
              ? "Open a new business day to continue."
              : "Enter the starting cash float to open today's business day."}
          </p>
          <label htmlFor="initialFloat" className="mb-1 block text-left text-[11px] text-[#8a8e83]">
            Initial float (R)
          </label>
          <input
            id="initialFloat"
            inputMode="numeric"
            value={floatInput}
            onChange={(e) => setFloatInput(e.target.value.replace(/[^0-9]/g, ""))}
            className="mb-3 w-full rounded-[9px] border border-input px-3 py-3 text-center font-mono text-xl font-semibold"
          />
          {error && <p className="mb-3 text-[12.5px] text-destructive">{error}</p>}
          <button
            type="button"
            onClick={handleOpenDay}
            disabled={isPending}
            className="w-full rounded-[9px] py-3 text-[14px] font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#e4e1d7] disabled:text-[#a29c8c]"
            style={!isPending ? { background: "var(--primary)" } : undefined}
          >
            {isPending ? "Opening…" : "Open business day"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3.5 flex items-center justify-between rounded-card border border-border bg-card p-4">
        <div className="text-[13px]">
          {myOpenShift ? (
            <span>
              Clocked in {timeLabel(myOpenShift.clockIn)}
              {myOpenShift.workstationName ? ` · ${myOpenShift.workstationName}` : ""}
            </span>
          ) : (
            <span className="text-[#8a8e83]">You are not clocked in</span>
          )}
        </div>
        {myOpenShift ? (
          <div className="flex items-center gap-2">
            <label htmlFor="myCashOut" className="sr-only">
              Cash out amount
            </label>
            <input
              id="myCashOut"
              inputMode="numeric"
              placeholder="Cash out (R)"
              value={cashOutDrafts[myOpenShift.id] ?? ""}
              onChange={(e) =>
                setCashOutDrafts((prev) => ({
                  ...prev,
                  [myOpenShift.id]: e.target.value.replace(/[^0-9]/g, ""),
                }))
              }
              className="w-[130px] rounded-[8px] border border-input px-3 py-2 font-mono text-[13px]"
            />
            <button
              type="button"
              onClick={() => handleClockOut(myOpenShift, false)}
              disabled={isPending}
              className="rounded-[8px] px-4 py-2 text-[13px] font-semibold text-white"
              style={{ background: "var(--primary)" }}
            >
              Clock out
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <label htmlFor="clockInWorkstation" className="sr-only">
              Workstation
            </label>
            <select
              id="clockInWorkstation"
              value={workstationInput}
              onChange={(e) => setWorkstationInput(e.target.value)}
              className="rounded-[8px] border border-input bg-card px-3 py-2 text-[13px]"
            >
              <option value="">No workstation</option>
              {workstations.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleClockIn}
              disabled={isPending}
              className="rounded-[8px] px-4 py-2 text-[13px] font-semibold text-white"
              style={{ background: "var(--primary)" }}
            >
              Clock in
            </button>
          </div>
        )}
      </div>

      {error && <p className="mb-3 text-[12.5px] text-destructive">{error}</p>}

      <div className="mb-4 grid grid-cols-3 gap-3.5">
        <div className="rounded-card border border-border bg-card p-[17px]">
          <div className="text-xs text-[#6b6f66]">Business day</div>
          <div className="mt-1.5 font-heading text-[17px] font-semibold">
            Open ·{" "}
            {new Date(businessDay.openedAt).toLocaleDateString("en-ZA", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}
          </div>
          <div className="mt-0.5 text-[11.5px] text-[#8a8e83]">
            Opened {timeLabel(businessDay.openedAt)} by {businessDay.openedByEmail}
          </div>
        </div>
        <div className="rounded-card border border-border bg-card p-[17px]">
          <div className="text-xs text-[#6b6f66]">Initial float</div>
          <div className="mt-1.5 font-mono text-[22px] font-semibold">
            {formatRand(businessDay.initialFloat)}
          </div>
        </div>
        <div className="rounded-card border border-border bg-card p-[17px]">
          <div className="text-xs text-[#6b6f66]">Cash donations today</div>
          <div className="mt-1.5 font-mono text-[22px] font-semibold text-primary">
            {formatRand(cashDonationsToday)}
          </div>
          <div className="mt-0.5 text-[11.5px] text-[#8a8e83]">
            Expected in drawer: {formatRand(expectedInDrawer)}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_300px] items-start gap-4">
        <div className="overflow-hidden rounded-card border border-border bg-card">
          <div className="border-b border-border px-[18px] py-3.5 font-heading text-[15px] font-semibold">
            Shifts today
          </div>
          <div className="grid grid-cols-[1fr_100px_100px_110px_90px_110px] gap-3 border-b border-border bg-muted px-[18px] py-2.5 text-[11px] font-semibold uppercase tracking-[.05em] text-[#8a8e83]">
            <div>Staff</div>
            <div>Start</div>
            <div>End</div>
            <div>Cash out</div>
            <div>Status</div>
            <div></div>
          </div>
          {shifts.length === 0 ? (
            <div className="px-[18px] py-10 text-center text-[12.5px] text-[#9a9e93]">No shifts yet today.</div>
          ) : (
            shifts.map((s) => (
              <div
                key={s.id}
                className="grid grid-cols-[1fr_100px_100px_110px_90px_110px] items-center gap-3 border-b border-[#f4f2ea] px-[18px] py-3 text-[13px] last:border-b-0"
              >
                <div className="truncate font-medium">{s.staffEmail}</div>
                <div className="font-mono text-[#6b6f66]">{timeLabel(s.clockIn)}</div>
                <div className="font-mono text-[#6b6f66]">{s.clockOut ? timeLabel(s.clockOut) : "—"}</div>
                <div className="font-mono">{s.cashOut !== null ? formatRand(s.cashOut) : "—"}</div>
                <div>
                  <span
                    className={
                      s.status === "open"
                        ? "rounded-full bg-status-active-bg px-2.5 py-1 text-[11px] font-medium text-status-active-fg"
                        : "rounded-full bg-status-inactive-bg px-2.5 py-1 text-[11px] font-medium text-status-inactive-fg"
                    }
                  >
                    {s.status}
                  </span>
                </div>
                <div>
                  {s.status === "open" && s.staffEmail !== currentUserEmail && (
                    <div className="flex items-center gap-1.5">
                      <label htmlFor={`forceCashOut-${s.id}`} className="sr-only">
                        Cash out amount
                      </label>
                      <input
                        id={`forceCashOut-${s.id}`}
                        inputMode="numeric"
                        placeholder="R"
                        value={cashOutDrafts[s.id] ?? ""}
                        onChange={(e) =>
                          setCashOutDrafts((prev) => ({
                            ...prev,
                            [s.id]: e.target.value.replace(/[^0-9]/g, ""),
                          }))
                        }
                        className="w-[54px] rounded-[6px] border border-input px-1.5 py-1 font-mono text-[11px]"
                      />
                      <button
                        type="button"
                        onClick={() => handleClockOut(s, true)}
                        disabled={isPending}
                        className="rounded-[6px] border border-input bg-muted px-2 py-1 text-[11px] font-medium text-[#6b6f66]"
                      >
                        Force close
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="rounded-card border border-border bg-card p-[18px]">
          <div className="mb-3 font-heading text-[15px] font-semibold">Workstations</div>
          {workstations.length === 0 ? (
            <div className="py-4 text-center text-[12px] text-[#9a9e93]">No workstations yet.</div>
          ) : (
            workstations.map((w) => {
              const inUse = shifts.some((s) => s.workstationId === w.id && s.status === "open");
              return (
                <div
                  key={w.id}
                  className="flex items-center gap-2.5 border-b border-[#f0eee6] py-2.5 last:border-b-0"
                >
                  <div className="h-2 w-2 rounded-full" style={{ background: inUse ? "#6fbf82" : "#d9b25a" }} />
                  <div className="flex-1">
                    <div className="text-[13px] font-medium">{w.name}</div>
                    <div className="text-[11px] text-[#9a9e93]">{inUse ? "In use" : "Idle"}</div>
                  </div>
                </div>
              );
            })
          )}
          <div className="mt-3 flex gap-2">
            <label htmlFor="newWorkstationName" className="sr-only">
              New workstation name
            </label>
            <input
              id="newWorkstationName"
              value={newWorkstationName}
              onChange={(e) => setNewWorkstationName(e.target.value)}
              placeholder="New workstation name"
              className="flex-1 rounded-[8px] border border-input px-3 py-2 text-[13px]"
            />
            <button
              type="button"
              onClick={handleAddWorkstation}
              disabled={isPending}
              className="rounded-[8px] border border-input bg-muted px-3 py-2 text-[13px]"
            >
              Add
            </button>
          </div>
          <button
            type="button"
            onClick={handleCloseDay}
            disabled={isPending || openShiftsCount > 0}
            title={openShiftsCount > 0 ? `${openShiftsCount} shift(s) still open` : undefined}
            className="mt-3.5 w-full rounded-[9px] border border-input py-2.5 text-[13px] font-semibold text-[#4a4e45] disabled:cursor-not-allowed disabled:text-[#a29c8c]"
            style={{ background: "var(--muted)" }}
          >
            Close business day{openShiftsCount > 0 ? ` (${openShiftsCount} open)` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 6: Build**

Run: `node_modules/.bin/next build`
Expected: clean build; route table includes `ƒ /[clubSlug]/till`.

- [ ] **Step 7: Manual smoke test**

Start the dev server, sign in as `admin@gaafd.test` (club `demo`), navigate to `/demo/till`. Confirm:
- With no business day open: the "No business day open" card renders, entering a float and clicking "Open business day" succeeds and switches to the full dashboard.
- Add a workstation via the side panel; it appears in the list as "Idle".
- Click "Clock in" (with the new workstation selected) — the header switches to "Clocked in HH:MM · {workstation}", a new row appears in "Shifts today" with status `open`, and the workstation panel now shows that workstation as "In use".
- Enter a cash-out amount and click "Clock out" — the row updates to `closed` with the cash-out amount shown, the workstation reverts to "Idle".
- Click "Close business day" — succeeds (no shifts open), shows a toast with the real counted/expected/variance figures, and the screen reverts to the empty-state card.

- [ ] **Step 8: Commit**

```bash
git add "src/app/[clubSlug]/till"
git commit -m "Build the Till & shifts screen (business day, clock in/out, reconciliation)"
```
