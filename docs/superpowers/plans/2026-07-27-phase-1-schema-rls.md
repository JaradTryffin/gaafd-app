# GaafD Phase 1 — Supabase Schema + RLS + Tenant Isolation Proof

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the full Supabase schema, Row Level Security policies, and Storage policies for GaafD, then prove — with a real Vitest suite against the live cloud project — that a club can never read or write another club's data, and that the platform role is aggregate-only with zero row-level access to operational data. This suite is a hard gate: phase 2 (auth/membership UI) does not start until it is green.

**Architecture:** Three SQL migrations applied via `supabase db push` against the linked cloud project (ref `inlseklfbptgjketdnpe`) — schema, then RLS, then Storage — followed by a Vitest integration suite that seeds real data via a service-role admin client, signs in as real users via the anon client, and asserts cross-tenant access is denied at the database level.

**Tech Stack:** Supabase Postgres + Auth + Storage, Supabase CLI (already linked), `@supabase/supabase-js` (already installed), Vitest (already installed).

## Global Constraints

- Repo root: `/Users/user/Documents/projects/gaafd-app`. Supabase project ref `inlseklfbptgjketdnpe`, already linked (`supabase link` done, `supabase/config.toml` committed).
- Credentials are in `.env.local` (gitignored, already populated): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_PASSWORD`.
- Migrations go in `supabase/migrations/`, applied with `supabase db push --linked` (pushes to the linked cloud project directly — no local Docker stack is used in this phase).
- RLS pattern, exactly as the spec mandates (`docs/superpowers/specs/2026-07-25-gaafd-saas-design.md`):
  - `my_club_ids()` and `is_platform()` are `SECURITY DEFINER`, `SET search_path = public`, and every policy wraps calls to them as `(select my_club_ids())` / `(select is_platform())` so Postgres evaluates them once per statement, not once per row.
  - `club_users` and `platform_users` each get a SELECT policy of exactly `user_id = auth.uid()` — no helper calls, to avoid recursion (the helpers read these tables internally as `SECURITY DEFINER`, bypassing RLS on them).
  - Every operational table (`members`, `products`, `inventory_moves`, `donations`, `contract_templates`, `signed_contracts`) is **tenant-only** — no `is_platform()` bypass anywhere in their policies.
  - `clubs` gets a SELECT policy of `id in (select my_club_ids()) or (select is_platform())` — the only table-level policy where `is_platform()` appears.
  - `platform_club_stats()` is the only other place `is_platform()` appears — a `SECURITY DEFINER` function returning aggregate counts only, empty for non-platform callers.
  - `clubs`, `club_users`, `platform_users` have **no INSERT/UPDATE/DELETE policies for `authenticated`** — those writes go through service-role server actions in phase 2, not through RLS-gated client writes.
- Additional correctness requirement from the spec, applied during schema design: `inventory_moves` and `signed_contracts` are **append-only audit records** — "never edit/delete past movements" and "never mutate" respectively (spec's Screens section, item 11, and Data model section). Their RLS policies therefore only ever grant SELECT and INSERT, never UPDATE or DELETE, for any role including the owning tenant. `members`, `products`, `donations`, `contract_templates` get full tenant-scoped SELECT/INSERT/UPDATE/DELETE.
- `products.stock` does not exist as a column — derived via a `product_stock` view (`SUM(qty)` over `inventory_moves`, created `WITH (security_invoker = true)` so it inherits the querying user's RLS instead of the view owner's).
- Storage: private `signatures` bucket, objects keyed `{club_id}/{member_id}/{signed_contract_id}.png`, RLS parses `(storage.foldername(name))[1]::uuid` as the club id and checks `my_club_ids()` only — no platform bypass, no UPDATE/DELETE policies (same immutability posture as `signed_contracts`).
- Test users created by the isolation suite use real Supabase Auth (`admin.createUser` with `email_confirm: true`) and real `signInWithPassword` sessions — not mocked JWTs — because the whole point is proving RLS holds under the real auth path.
- The isolation suite must clean up everything it creates (`afterAll`), since it runs against the live cloud project, not an ephemeral local one.
- Commit message: plain, imperative. Work on branch `master` directly (already consented for this project).

---

## File Structure

- `supabase/migrations/20260727130000_core_schema.sql` — all 9 tables, indexes, the `product_stock` view. No RLS yet (Task 1).
- `supabase/migrations/20260727130100_rls_policies.sql` — `my_club_ids()`, `is_platform()`, `platform_club_stats()`, RLS enabled + policies on every table (Task 2).
- `supabase/migrations/20260727130200_storage_signatures.sql` — `signatures` bucket + its RLS policies (Task 3).
- `src/lib/supabase/admin.ts` — new service-role admin client (deferred from phase 0 per its own plan note) (Task 4).
- `tests/rls/fixtures.ts` — seed/cleanup helpers for the isolation suite, with its own smoke test (Task 4).
- `tests/rls/fixtures.test.ts` — smoke test for the fixtures module (Task 4).
- `tests/rls/isolation.test.ts` — the phase-1 gate: full cross-tenant and platform-scope assertions (Task 5).
- `vitest.config.ts` — modified to load `.env.local` into `process.env` for the test run (Task 4).

---

### Task 1: Core schema migration

**Files:**
- Create: `supabase/migrations/20260727130000_core_schema.sql`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: 9 tables (`clubs`, `club_users`, `platform_users`, `members`, `products`, `inventory_moves`, `donations`, `contract_templates`, `signed_contracts`) and a `product_stock` view — consumed by every later task in this plan and every future phase

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260727130000_core_schema.sql`:

```sql
create extension if not exists pgcrypto with schema extensions;

create table clubs (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  initials text not null,
  plan text not null check (plan in ('Trial','Starter','Growth','Enterprise')),
  region text not null,
  accent_color text not null,
  status text not null default 'trial' check (status in ('active','trial','suspended')),
  mrr numeric(10,2) not null default 0,
  created_at timestamptz not null default now()
);

create table club_users (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('staff','admin')),
  created_at timestamptz not null default now(),
  unique (club_id, user_id)
);
create index club_users_user_id_idx on club_users(user_id);
create index club_users_club_id_idx on club_users(club_id);

create table platform_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table members (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  code text not null,
  first text not null,
  last text not null,
  type text not null check (type in ('Full member','Day pass','Trial')),
  status text not null default 'active' check (status in ('active','inactive')),
  token_balance integer not null default 0,
  referrer_id uuid references members(id) on delete set null,
  phone text,
  email text,
  app_handle text,
  joined_at timestamptz not null default now(),
  unique (club_id, code)
);
create index members_club_id_idx on members(club_id);

create table products (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  name text not null,
  category text not null check (category in ('Flower','Pre-rolls','Edibles','Concentrate','Accessory')),
  unit text not null,
  token_price integer not null,
  sell_price numeric(10,2) not null,
  cost numeric(10,2),
  description text,
  flags text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index products_club_id_idx on products(club_id);

create table inventory_moves (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  product_id uuid not null references products(id) on delete restrict,
  type text not null check (type in ('PURCHASE','SALE','ADJUSTMENT','WASTE')),
  qty integer not null,
  cost numeric(10,2),
  batch text,
  expiry date,
  reference text,
  staff_id uuid references club_users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index inventory_moves_club_id_idx on inventory_moves(club_id);
create index inventory_moves_product_id_idx on inventory_moves(product_id);

-- Stock is always derived, never stored — security_invoker so this view
-- respects the querying user's RLS on inventory_moves, not the view owner's.
create view product_stock
with (security_invoker = true) as
  select product_id, club_id, coalesce(sum(qty), 0)::integer as stock
  from inventory_moves
  group by product_id, club_id;

create table donations (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  amount_rand numeric(10,2) not null,
  method text not null check (method in ('Cash','Card','EFT')),
  tokens_credited integer not null,
  created_at timestamptz not null default now()
);
create index donations_club_id_idx on donations(club_id);
create index donations_member_id_idx on donations(member_id);

create table contract_templates (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null unique references clubs(id) on delete cascade,
  title text not null,
  subtitle text not null,
  consent text not null,
  clauses jsonb not null,
  version integer not null default 1,
  updated_at timestamptz not null default now()
);

-- signature_url stores the Storage object PATH (e.g. "{club_id}/{member_id}/x.png"),
-- not a public URL — the bucket is private, so callers generate a signed URL
-- on demand from this path.
create table signed_contracts (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  template_version integer not null,
  contract_snapshot jsonb not null,
  consent boolean not null,
  printed_name text,
  signature_url text not null,
  signed_at timestamptz not null default now()
);
create index signed_contracts_club_id_idx on signed_contracts(club_id);
create index signed_contracts_member_id_idx on signed_contracts(member_id);
```

- [ ] **Step 2: Push the migration to the linked cloud project**

```bash
cd /Users/user/Documents/projects/gaafd-app
supabase db push --linked
```

Expected: lists the one new migration, prompts to confirm, applies it, ends with something like `Applying migration 20260727130000_core_schema.sql... Finished supabase db push.`

- [ ] **Step 3: Verify the tables exist**

```bash
supabase db push --linked --dry-run
```

Expected: reports no pending migrations (everything already applied) — confirms the migration landed.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260727130000_core_schema.sql
git commit -m "Add core Supabase schema (9 tables + product_stock view)"
```

---

### Task 2: RLS helper functions and policies

**Files:**
- Create: `supabase/migrations/20260727130100_rls_policies.sql`

**Interfaces:**
- Consumes: the 9 tables from Task 1
- Produces: `my_club_ids()`, `is_platform()`, `platform_club_stats()` (SQL functions, callable via `.rpc("platform_club_stats")` from the JS client) — consumed by Task 5's isolation suite and every future phase's data access

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260727130100_rls_policies.sql`:

```sql
create or replace function my_club_ids()
returns setof uuid
language sql
security definer
set search_path = public
stable
as $$
  select club_id from club_users where user_id = auth.uid();
$$;

create or replace function is_platform()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from platform_users where user_id = auth.uid());
$$;

grant execute on function my_club_ids() to authenticated;
grant execute on function is_platform() to authenticated;

-- clubs: read own club or, read-only, every club if platform
alter table clubs enable row level security;
create policy clubs_select on clubs for select to authenticated
  using ( id in (select my_club_ids()) or (select is_platform()) );

-- club_users: read own membership rows only. No helper calls here —
-- my_club_ids() reads this table, so this policy must not call it back.
alter table club_users enable row level security;
create policy club_users_select_own on club_users for select to authenticated
  using ( user_id = auth.uid() );

-- platform_users: read own row only, same recursion guard as club_users.
alter table platform_users enable row level security;
create policy platform_users_select_own on platform_users for select to authenticated
  using ( user_id = auth.uid() );

-- members: full tenant-scoped CRUD, no platform bypass.
alter table members enable row level security;
create policy members_select on members for select to authenticated
  using ( club_id in (select my_club_ids()) );
create policy members_insert on members for insert to authenticated
  with check ( club_id in (select my_club_ids()) );
create policy members_update on members for update to authenticated
  using ( club_id in (select my_club_ids()) )
  with check ( club_id in (select my_club_ids()) );
create policy members_delete on members for delete to authenticated
  using ( club_id in (select my_club_ids()) );

-- products: full tenant-scoped CRUD, no platform bypass.
alter table products enable row level security;
create policy products_select on products for select to authenticated
  using ( club_id in (select my_club_ids()) );
create policy products_insert on products for insert to authenticated
  with check ( club_id in (select my_club_ids()) );
create policy products_update on products for update to authenticated
  using ( club_id in (select my_club_ids()) )
  with check ( club_id in (select my_club_ids()) );
create policy products_delete on products for delete to authenticated
  using ( club_id in (select my_club_ids()) );

-- inventory_moves: append-only audit ledger — SELECT + INSERT only, for
-- anyone, including the owning tenant. Corrections are new rows, never
-- UPDATE/DELETE.
alter table inventory_moves enable row level security;
create policy inventory_moves_select on inventory_moves for select to authenticated
  using ( club_id in (select my_club_ids()) );
create policy inventory_moves_insert on inventory_moves for insert to authenticated
  with check ( club_id in (select my_club_ids()) );

-- donations: full tenant-scoped CRUD, no platform bypass.
alter table donations enable row level security;
create policy donations_select on donations for select to authenticated
  using ( club_id in (select my_club_ids()) );
create policy donations_insert on donations for insert to authenticated
  with check ( club_id in (select my_club_ids()) );
create policy donations_update on donations for update to authenticated
  using ( club_id in (select my_club_ids()) )
  with check ( club_id in (select my_club_ids()) );
create policy donations_delete on donations for delete to authenticated
  using ( club_id in (select my_club_ids()) );

-- contract_templates: full tenant-scoped CRUD, no platform bypass.
alter table contract_templates enable row level security;
create policy contract_templates_select on contract_templates for select to authenticated
  using ( club_id in (select my_club_ids()) );
create policy contract_templates_insert on contract_templates for insert to authenticated
  with check ( club_id in (select my_club_ids()) );
create policy contract_templates_update on contract_templates for update to authenticated
  using ( club_id in (select my_club_ids()) )
  with check ( club_id in (select my_club_ids()) );
create policy contract_templates_delete on contract_templates for delete to authenticated
  using ( club_id in (select my_club_ids()) );

-- signed_contracts: append-only legal record — SELECT + INSERT only, for
-- anyone, including the owning tenant. Never mutated after signing.
alter table signed_contracts enable row level security;
create policy signed_contracts_select on signed_contracts for select to authenticated
  using ( club_id in (select my_club_ids()) );
create policy signed_contracts_insert on signed_contracts for insert to authenticated
  with check ( club_id in (select my_club_ids()) );

-- platform aggregate-only reporting: the only other place is_platform()
-- appears. Returns empty (not an error) for non-platform callers, so the
-- client can treat it as "no data" rather than needing to catch an
-- exception.
create type platform_club_stat as (
  club_id uuid,
  member_count bigint
);

create or replace function platform_club_stats()
returns setof platform_club_stat
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not is_platform() then
    return;
  end if;
  return query
    select c.id, count(m.id)
    from clubs c
    left join members m on m.club_id = c.id
    group by c.id;
end;
$$;

grant execute on function platform_club_stats() to authenticated;

-- Deliberately no INSERT/UPDATE/DELETE policies on clubs, club_users, or
-- platform_users for the `authenticated` role. With RLS enabled and no
-- write policy, Postgres denies the write to everyone in that role —
-- onboarding a club, granting membership, or granting platform access all
-- go through a service-role server action (phase 2+), never a client
-- write gated by these policies.
```

- [ ] **Step 2: Push the migration**

```bash
cd /Users/user/Documents/projects/gaafd-app
supabase db push --linked
```

Expected: applies the migration, ends with `Finished supabase db push.`

- [ ] **Step 3: Smoke-check RLS is actually enabled**

```bash
supabase db push --linked --dry-run
```

Expected: no pending migrations.

Then, using the Supabase SQL editor or `psql` via the connection string (`supabase db push` already proves connectivity — this step is just a sanity read), confirm every table shows `rowsecurity = true`:

```bash
PGPASSWORD="$(grep SUPABASE_DB_PASSWORD .env.local | cut -d= -f2)" psql \
  "postgresql://postgres.inlseklfbptgjketdnpe:$(grep SUPABASE_DB_PASSWORD .env.local | cut -d= -f2)@aws-0-eu-west-3.pooler.supabase.com:5432/postgres" \
  -c "select tablename, rowsecurity from pg_tables where schemaname='public' order by tablename;"
```

Expected: every row shows `rowsecurity = t`. If `psql` isn't installed or the pooler hostname differs, skip this step — Task 5's actual isolation suite is the real proof, this is just an early sanity check.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260727130100_rls_policies.sql
git commit -m "Add RLS helper functions and tenant-isolation policies"
```

---

### Task 3: Storage bucket and policies

**Files:**
- Create: `supabase/migrations/20260727130200_storage_signatures.sql`

**Interfaces:**
- Consumes: `my_club_ids()` from Task 2
- Produces: a private `signatures` Storage bucket with tenant-scoped SELECT/INSERT policies — consumed by Task 5's isolation suite and phase 4's sign flow

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260727130200_storage_signatures.sql`:

```sql
insert into storage.buckets (id, name, public)
values ('signatures', 'signatures', false)
on conflict (id) do nothing;

-- Path convention: {club_id}/{member_id}/{signed_contract_id}.png
-- storage.foldername(name) splits the object path into its folder
-- segments; [1] is the first one, i.e. the club id.
create policy signatures_select on storage.objects for select to authenticated
  using (
    bucket_id = 'signatures'
    and (storage.foldername(name))[1]::uuid in (select my_club_ids())
  );

create policy signatures_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'signatures'
    and (storage.foldername(name))[1]::uuid in (select my_club_ids())
  );
```

- [ ] **Step 2: Push the migration**

```bash
cd /Users/user/Documents/projects/gaafd-app
supabase db push --linked
```

Expected: applies the migration cleanly.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260727130200_storage_signatures.sql
git commit -m "Add signatures Storage bucket and tenant-scoped policies"
```

---

### Task 4: Admin client, env loading, and test fixtures

**Files:**
- Create: `src/lib/supabase/admin.ts`
- Modify: `vitest.config.ts` (load `.env.local` into `process.env` for tests)
- Create: `tests/rls/fixtures.ts`
- Create: `tests/rls/fixtures.test.ts`

**Interfaces:**
- Consumes: the schema from Task 1, RLS from Task 2, Storage from Task 3
- Produces: `createAdminClient(): SupabaseClient` from `src/lib/supabase/admin.ts` (service-role, bypasses RLS — used by tests now, by server actions from phase 2 onward); `seedTenants(): Promise<SeededData>`, `cleanupTenants(data: SeededData): Promise<void>`, `signInAs(email: string, password: string): Promise<SupabaseClient>` from `tests/rls/fixtures.ts` — consumed by Task 5's isolation suite

- [ ] **Step 1: Create the admin client**

Create `src/lib/supabase/admin.ts`:

```ts
import { createClient } from "@supabase/supabase-js";

// Service-role client — bypasses RLS entirely. Server-only: never import
// this from a Client Component or anything that ships to the browser.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
```

- [ ] **Step 2: Load `.env.local` into the Vitest process**

Replace `vitest.config.ts` with:

```ts
import { defineConfig, loadEnv } from "vitest/config";
import path from "node:path";

export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    env: loadEnv(mode, process.cwd(), ""),
  },
}));
```

`loadEnv(mode, dir, '')` with an empty prefix loads every variable from `.env`/`.env.local` (not just `VITE_`-prefixed ones) into `test.env`, which Vitest injects into `process.env` for the test run. This is why `src/lib/supabase/admin.ts` and `tests/rls/fixtures.ts` can read `process.env.SUPABASE_SERVICE_ROLE_KEY` etc. without any other wiring.

- [ ] **Step 3: Verify env loading works**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use
cd /Users/user/Documents/projects/gaafd-app
pnpm exec vitest run src/lib/utils.test.ts
```

Expected: still `2 passed` (this doesn't touch env vars, just confirms the config change didn't break the existing suite).

- [ ] **Step 4: Write the fixtures module**

Create `tests/rls/fixtures.ts`:

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

export type SeededClub = {
  clubId: string;
  slug: string;
  adminEmail: string;
  adminPassword: string;
  adminUserId: string;
  memberId: string;
  productId: string;
  inventoryMoveId: string;
  donationId: string;
  contractTemplateId: string;
  signedContractId: string;
  signaturePath: string;
};

export type SeededData = {
  clubA: SeededClub;
  clubB: SeededClub;
  platformEmail: string;
  platformPassword: string;
  platformUserId: string;
};

const PASSWORD = "Test-Password-123!";

// A minimal valid 1x1 PNG — content doesn't matter, only that Storage
// accepts the upload so RLS on the object can be exercised.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function seedClub(admin: SupabaseClient, label: string): Promise<SeededClub> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const slug = `rls-test-${label}-${suffix}`;

  const { data: club, error: clubError } = await admin
    .from("clubs")
    .insert({
      slug,
      name: `RLS Test Club ${label} ${suffix}`,
      initials: label.toUpperCase(),
      plan: "Trial",
      region: "Test Region",
      accent_color: "#3f7a4e",
      status: "active",
    })
    .select()
    .single();
  if (clubError) throw clubError;

  const adminEmail = `rls-admin-${label}-${suffix}@example.test`;
  const { data: authUser, error: authError } = await admin.auth.admin.createUser({
    email: adminEmail,
    password: PASSWORD,
    email_confirm: true,
  });
  if (authError) throw authError;

  const { error: membershipError } = await admin.from("club_users").insert({
    club_id: club.id,
    user_id: authUser.user.id,
    role: "admin",
  });
  if (membershipError) throw membershipError;

  const { data: member, error: memberError } = await admin
    .from("members")
    .insert({
      club_id: club.id,
      code: `${label.toUpperCase()}-0001`,
      first: "Test",
      last: "Member",
      type: "Full member",
      status: "active",
      token_balance: 100,
    })
    .select()
    .single();
  if (memberError) throw memberError;

  const { data: product, error: productError } = await admin
    .from("products")
    .insert({
      club_id: club.id,
      name: "Test Product",
      category: "Flower",
      unit: "per 1g",
      token_price: 45,
      sell_price: 60,
    })
    .select()
    .single();
  if (productError) throw productError;

  const { data: move, error: moveError } = await admin
    .from("inventory_moves")
    .insert({
      club_id: club.id,
      product_id: product.id,
      type: "PURCHASE",
      qty: 100,
    })
    .select()
    .single();
  if (moveError) throw moveError;

  const { data: donation, error: donationError } = await admin
    .from("donations")
    .insert({
      club_id: club.id,
      member_id: member.id,
      amount_rand: 300,
      method: "Cash",
      tokens_credited: 300,
    })
    .select()
    .single();
  if (donationError) throw donationError;

  const { data: template, error: templateError } = await admin
    .from("contract_templates")
    .insert({
      club_id: club.id,
      title: `${label.toUpperCase()} Member Agreement`,
      subtitle: "Test subtitle",
      consent: "Test consent",
      clauses: [{ heading: "Intro", body: "Test clause body" }],
    })
    .select()
    .single();
  if (templateError) throw templateError;

  const signaturePath = `${club.id}/${member.id}/sig-${suffix}.png`;
  const { error: uploadError } = await admin.storage
    .from("signatures")
    .upload(signaturePath, TINY_PNG, { contentType: "image/png" });
  if (uploadError) throw uploadError;

  const { data: signedContract, error: signedContractError } = await admin
    .from("signed_contracts")
    .insert({
      club_id: club.id,
      member_id: member.id,
      template_version: template.version,
      contract_snapshot: {
        title: template.title,
        subtitle: template.subtitle,
        consent: template.consent,
        clauses: template.clauses,
      },
      consent: true,
      printed_name: "Test Member",
      signature_url: signaturePath,
    })
    .select()
    .single();
  if (signedContractError) throw signedContractError;

  return {
    clubId: club.id,
    slug,
    adminEmail,
    adminPassword: PASSWORD,
    adminUserId: authUser.user.id,
    memberId: member.id,
    productId: product.id,
    inventoryMoveId: move.id,
    donationId: donation.id,
    contractTemplateId: template.id,
    signedContractId: signedContract.id,
    signaturePath,
  };
}

export async function seedTenants(): Promise<SeededData> {
  const admin = createAdminClient();

  const clubA = await seedClub(admin, "a");
  const clubB = await seedClub(admin, "b");

  const suffix = crypto.randomUUID().slice(0, 8);
  const platformEmail = `rls-platform-${suffix}@example.test`;
  const { data: platformAuthUser, error: platformAuthError } = await admin.auth.admin.createUser({
    email: platformEmail,
    password: PASSWORD,
    email_confirm: true,
  });
  if (platformAuthError) throw platformAuthError;

  const { error: platformInsertError } = await admin
    .from("platform_users")
    .insert({ user_id: platformAuthUser.user.id });
  if (platformInsertError) throw platformInsertError;

  return {
    clubA,
    clubB,
    platformEmail,
    platformPassword: PASSWORD,
    platformUserId: platformAuthUser.user.id,
  };
}

export async function cleanupTenants(data: SeededData): Promise<void> {
  const admin = createAdminClient();

  await admin.storage
    .from("signatures")
    .remove([data.clubA.signaturePath, data.clubB.signaturePath]);
  // Deleting the clubs cascades to club_users, members, products,
  // inventory_moves, donations, contract_templates, signed_contracts —
  // every one of those FKs is `on delete cascade`.
  await admin.from("clubs").delete().in("id", [data.clubA.clubId, data.clubB.clubId]);
  await admin.auth.admin.deleteUser(data.clubA.adminUserId);
  await admin.auth.admin.deleteUser(data.clubB.adminUserId);
  await admin.auth.admin.deleteUser(data.platformUserId);
}

export async function signInAs(email: string, password: string): Promise<SupabaseClient> {
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}
```

- [ ] **Step 5: Write the fixtures smoke test**

Create `tests/rls/fixtures.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin";
import { seedTenants, cleanupTenants, type SeededData } from "./fixtures";

let data: SeededData;

beforeAll(async () => {
  data = await seedTenants();
}, 30000);

afterAll(async () => {
  await cleanupTenants(data);
}, 30000);

describe("seedTenants", () => {
  it("creates two distinct clubs with all child rows", () => {
    expect(data.clubA.clubId).toBeTruthy();
    expect(data.clubB.clubId).toBeTruthy();
    expect(data.clubA.clubId).not.toBe(data.clubB.clubId);
    for (const club of [data.clubA, data.clubB]) {
      expect(club.adminUserId).toBeTruthy();
      expect(club.memberId).toBeTruthy();
      expect(club.productId).toBeTruthy();
      expect(club.inventoryMoveId).toBeTruthy();
      expect(club.donationId).toBeTruthy();
      expect(club.contractTemplateId).toBeTruthy();
      expect(club.signedContractId).toBeTruthy();
    }
  });

  it("creates a platform user with no club membership", async () => {
    const admin = createAdminClient();
    const { data: rows } = await admin
      .from("club_users")
      .select("id")
      .eq("user_id", data.platformUserId);
    expect(rows).toEqual([]);
  });

  it("uploads a real signature object to Storage", async () => {
    const admin = createAdminClient();
    const { data: file, error } = await admin.storage
      .from("signatures")
      .download(data.clubA.signaturePath);
    expect(error).toBeNull();
    expect(file).not.toBeNull();
  });
});
```

- [ ] **Step 6: Run it**

```bash
pnpm exec vitest run tests/rls/fixtures.test.ts
```

Expected: `3 passed`. This hits the live Supabase project — if it fails on auth/insert errors, check `.env.local` has the right project's keys and that Tasks 1-3's migrations are actually applied (`supabase db push --linked --dry-run` should show nothing pending).

- [ ] **Step 7: Commit**

```bash
git add src/lib/supabase/admin.ts vitest.config.ts tests/rls/fixtures.ts tests/rls/fixtures.test.ts
git commit -m "Add Supabase admin client and RLS test fixtures"
```

---

### Task 5: The tenant-isolation gate

**Files:**
- Create: `tests/rls/isolation.test.ts`

**Interfaces:**
- Consumes: `seedTenants`, `cleanupTenants`, `signInAs`, `SeededData` from `tests/rls/fixtures.ts`; `createAdminClient` from `src/lib/supabase/admin.ts`
- Produces: the phase-1 exit criterion itself — a green run of this file is what unblocks phase 2

- [ ] **Step 1: Write the isolation suite**

Create `tests/rls/isolation.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use
cd /Users/user/Documents/projects/gaafd-app
pnpm exec vitest run tests/rls/isolation.test.ts
```

Expected: every test passes (6 sanity + 6 cross-read + 4 cross-write + 3 enumerated-id + 9 platform-scope + 2 plain-user = 30 tests). If anything fails, that's a real RLS bug — do not weaken a policy to make the test pass; fix the policy in a new migration (edit the Task 2/3 migration files directly, since they haven't shipped to any other environment yet, then `supabase db push --linked` again).

- [ ] **Step 3: Run the full suite to confirm nothing else broke**

```bash
pnpm test
```

Expected: all suites pass — `src/lib/utils.test.ts`, `tests/rls/fixtures.test.ts`, `tests/rls/isolation.test.ts`.

- [ ] **Step 4: Commit**

```bash
git add tests/rls/isolation.test.ts
git commit -m "Add tenant-isolation Vitest suite — the phase-1 exit gate"
```

---

## End of phase 1

Stop here for review. This is the hard gate the spec requires: **do not start phase 2 (auth + club membership UI) until `pnpm exec vitest run tests/rls/isolation.test.ts` is green.** Once approved, phase 2 covers: invite-only signup via service-role server actions, `club_users`/`platform_users` UI-facing wiring, active-club resolution via the `/[clubSlug]/...` route segment, and the role gate at the layout level.
