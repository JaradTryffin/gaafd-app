# GaafD — Multi-Tenant Cannabis Social Club SaaS — Design

Source material: `../gaafd/README.md` (design handoff), `../gaafd/design/GaafD.dc.html` (interactive HTML reference — layout/copy/behavior, not production code), `../gaafd/screenshots/*.png`.

## Overview

GaafD is a multi-tenant SaaS for South African private cannabis social clubs. Each club (tenant) runs its own membership register, token-based dispensing (POS), inventory ledger, donations, till/shift management, and a per-club custom member contract that new members sign during onboarding. A platform-operator role sees all tenants for billing/ops purposes only.

**The single hardest requirement, non-negotiable:** a club admin/staff member must never be able to read or write another club's data, at the database level, regardless of what the client sends. Enforced via Supabase Row Level Security, not client-side filtering.

## Stack

- Next.js (latest, App Router) + TypeScript
- Supabase: Postgres + Auth + Row Level Security + Storage
- Tailwind + shadcn/ui, matching the design tokens in the README (colors, type, radius, shadow)
- react-hook-form + zod for forms/validation
- pnpm
- Vitest for the RLS isolation suite and other logic tests

New repo: `gaafd-app/` (sibling to `gaafd/`, which stays as the read-only design reference).

## Routing

- `/[clubSlug]/dashboard`, `/[clubSlug]/dispense`, `/[clubSlug]/members`, `/[clubSlug]/members/[id]`, `/[clubSlug]/members/register`, `/[clubSlug]/members/register/sign`, `/[clubSlug]/products`, `/[clubSlug]/products/[id]`, `/[clubSlug]/inventory`, `/[clubSlug]/donations`, `/[clubSlug]/till`, `/[clubSlug]/settings/contract`
- `/platform` — platform-operator console, no club segment
- `/login`, `/accept-invite` — outside any club

The `clubSlug` URL segment **is** the active club. The club layout resolves it server-side, checks the caller has a `club_users` row for that club (or is in `platform_users`), and 404s/redirects otherwise. No separate "active club" cookie.

## Data model

```sql
clubs               (id, slug, name, initials, plan, region, accent_color, status, mrr, created_at)
club_users           (id, club_id, user_id, role)              -- role: 'staff' | 'admin'; many-to-many
platform_users       (user_id primary key)                      -- presence = cross-tenant platform access
members              (id, club_id, code, first, last, type, status, token_balance,
                       referrer_id, phone, email, app_handle, joined_at)
products             (id, club_id, name, category, unit, token_price, sell_price,
                       cost, description, flags text[], active bool)
inventory_moves      (id, club_id, product_id, type, qty, cost, batch, expiry,
                       reference, staff_id, created_at)         -- append-only, immutable
donations            (id, club_id, member_id, amount_rand, method, tokens_credited, created_at)
contract_templates   (id, club_id unique, title, subtitle, consent, clauses jsonb, version, updated_at)
signed_contracts     (id, club_id, member_id, template_version, contract_snapshot jsonb,
                       consent bool, printed_name, signature_url, signed_at)
```

Key decisions locked in for this design (resolving ambiguity in the source README):

- **`club_users` is many-to-many.** A person who owns/administers several specific clubs simply has one row per club they belong to — no separate "owner" role, no cross-club grant table. Their access is the union of their own rows and nothing else, which is what gives strict "Owner A has zero access to a club he doesn't own" isolation for free.
- **Platform access lives only in `platform_users`**, not as a role value on `club_users`. `club_users.role` is only ever `staff` or `admin`.
- **`members` are fully independent per club.** No cross-club person identity, no shared wallet. Same human joining two clubs = two unrelated rows, two unrelated token balances, two separate signed contracts.
- **`products.stock` does not exist as a column.** Stock is always `SUM(qty)` over `inventory_moves` for that product (a view, e.g. `product_stock`, or an aggregate query). `inventory_moves` rows are never updated or deleted — corrections are new `ADJUSTMENT`/`WASTE` rows.
- **`signed_contracts.contract_snapshot`** is a full jsonb copy of the exact title/subtitle/consent/clauses shown to the member at signing time. `template_version` is metadata for cross-referencing, not the source of truth — the snapshot is, so the audit record survives later template edits.

## Row Level Security

Two `SECURITY DEFINER` helper functions, owned by a privileged role so they read past RLS internally:

```sql
create function my_club_ids() returns setof uuid
  language sql security definer stable as $$
    select club_id from club_users where user_id = auth.uid()
  $$;

create function is_platform() returns boolean
  language sql security definer stable as $$
    select exists (select 1 from platform_users where user_id = auth.uid())
  $$;
```

**Recursion guard:** `club_users` and `platform_users` each get their own SELECT policy that does **not** call these helpers — just `user_id = auth.uid()`. The helpers only avoid infinite recursion because they run as `SECURITY DEFINER`, bypassing RLS on the tables they query internally; if their own tables' policies called back into them, it would recurse.

**Every tenant table** (`members`, `products`, `inventory_moves`, `donations`, `contract_templates`, `signed_contracts`):

```sql
-- SELECT: tenant members/staff/admins, plus read-only platform access
using ( club_id in (select my_club_ids()) or (select is_platform()) )

-- INSERT/UPDATE/DELETE: tenant only — platform never writes tenant operational data
using ( club_id in (select my_club_ids()) )
with check ( club_id in (select my_club_ids()) )
```

Note the `(select my_club_ids())` / `(select is_platform())` wrapping in every policy — this makes Postgres evaluate the helper once per statement (cached in the query's init plan) rather than once per row.

`clubs`, `club_users`, `platform_users` are **not** writable by authenticated users at all under RLS (no INSERT/UPDATE/DELETE policies for the `authenticated` role). Onboarding a new club, inviting a club's first admin, or granting platform access all go through a **service-role server action** — an explicit, auditable privileged code path, not a database-level bypass rule. `clubs` gets a SELECT policy identical in shape to the tenant tables above (own club, or platform).

**Storage:** a private `signatures` bucket, objects keyed by path `{club_id}/{member_id}/{signed_contract_id}.png`. Storage RLS policies parse the leading path segment as `club_id` and apply the same `my_club_ids()` / `is_platform()` logic.

## Phase 1 exit criteria — the tenant-isolation proof

A Vitest suite, run before any further phase starts:

1. Seed two clubs and their `contract_templates` via the service-role admin client.
2. Create two auth users via the admin API, each with a `club_users` row (`role='admin'`) in a different club.
3. Create one auth user with a `platform_users` row and no `club_users` row.
4. Sign in as each club user via the anon client (real password auth, not service role).
5. For every tenant table and the Storage bucket: as Club A's user, attempt SELECT/INSERT/UPDATE/DELETE scoped to Club B's ids (including guessed/enumerated ids) — assert empty result sets / permission-denied, never Club B's data.
6. As the platform user: confirm SELECT across both clubs' tenant tables succeeds (read-only), and confirm INSERT/UPDATE/DELETE against tenant tables is rejected even for the platform user.
7. As a plain club user: confirm no access to platform-only data.

This suite must be green before phase 2 begins.

## Auth

Email + password via Supabase Auth. Invite-only — no public signup route anywhere:

- Platform operator creates a club and invites its first admin from `/platform`, via a service-role server action that calls `supabase.auth.admin.inviteUserByEmail` and creates the `club_users` row (`role='admin'`) atomically.
- A club admin can invite additional staff into their own club. The server action first reads the caller's own `club_users` row (permitted under the simple self-row SELECT policy) and requires `role='admin'` for that specific `club_id` before it's allowed to proceed to the service-role invite call. A `staff`-role caller is rejected here.

## App shell

Sidebar (248px, dark), workspace switcher (lists the clubs the caller has a `club_users` row for, plus a link to `/platform` if they're in `platform_users`), nav grouped Operations / Accounting / Settings / Platform (platform role only), page header with search + primary action, bottom-center toast. Matches the README's design tokens exactly (colors, type, radius, shadow, spacing).

## Build phases

0. Scaffold Next.js + TypeScript + Tailwind + shadcn/ui, env wiring for Supabase. Commit.
1. Schema + RLS + isolation Vitest suite, green. Commit only once green.
2. Auth, invites, `club_users`/`platform_users`, active-club resolution via route segment, role gating. Commit.
3. App shell: sidebar, workspace switcher, header, toasts. Commit.
4. Contract template builder + member sign flow, end-to-end against Supabase: template CRUD, canvas signature capture (Pointer Events, Apple Pencil), Storage upload, `signed_contracts` snapshot write. Commit.
5. Remaining screens, one at a time, each reviewed and committed separately: Dashboard, Dispensing/POS, Members list + detail + registration step 1, Products + detail, Inventory, Donations, Till, Platform console.

## Out of scope for this design

- Cross-club member identity / shared wallets (explicitly rejected — members are per-club).
- Public self-signup (explicitly rejected — invite-only).
- Deployment/CI target — deferred until the app exists locally; not a blocker for phases 0–5.
- Automated browser/e2e testing (Playwright etc.) — manual in-browser verification per screen for now; can be added later if desired.
