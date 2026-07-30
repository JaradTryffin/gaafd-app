# Dispensing / POS Screen — Design Spec

**Status:** Approved
**Scope:** Phase 5, next screen for GaafD (South African cannabis social club SaaS). Adds `/[clubSlug]/dispense` — currently unbuilt (sidebar's "Dispensing" link 404s today). This is the largest and most transactionally complex screen in the app: a real checkout flow that must decrement both a member's token balance and product stock atomically.

## Context

Design reference: `/Users/user/Documents/projects/gaafd/README.md` (§2 "Dispensing / POS"), `design/GaafD.dc.html` (lines 181-261 the view, 1054-1074 the cart/checkout state, 1342-1358 `chgQty`/`doCheckout`), `screenshots/02-dispensing.png`.

**The mock's own checkout never actually decrements stock** — `doCheckout()` only mutates `member.balance` in memory (`member.balance = balAfter`), matching the same "prototype shortcut" pattern already found and worked around in every prior transactional screen (Products' delete guard, Inventory's movement logging, Donations' token credit). This spec builds the real thing: a genuinely atomic checkout that debits tokens AND decrements stock together.

**The mock's member picker is 4 hardcoded quick-pick chips** — doesn't scale past a demo. Per user decision, this build uses a real searchable type-ahead instead (a new UI pattern for this codebase; Donations/Inventory used plain `<select>` dropdowns, which don't suit a counter checkout flow where staff want to type a few letters and go).

## Schema

New migration, one table (per user-approved decision — mirrors the `contract_snapshot` pattern already proven in this codebase, avoiding a second normalized `dispense_order_items` table):

```sql
create table dispense_orders (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  token_total integer not null,
  items jsonb not null,
  staff_id uuid references club_users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index dispense_orders_club_id_idx on dispense_orders(club_id);
create index dispense_orders_member_id_idx on dispense_orders(member_id);

alter table inventory_moves add column order_id uuid references dispense_orders(id) on delete set null;
```

`items` is a JSON array snapshotting each line at time of sale: `[{ productId, productName, unit, qty, tokenPrice, lineTotal }, ...]`. Token prices can change later via Products edits; the order preserves what was actually charged — same principle as `signed_contracts.contract_snapshot`.

`inventory_moves.order_id` is nullable (only `SALE` rows created by a dispense ever set it — `PURCHASE`/`ADJUSTMENT`/`WASTE` rows never do) and traces each stock movement back to the order that caused it, for free product-side auditability later (Product Detail's future "related movements" view).

RLS (append-only, matching `signed_contracts`/`inventory_moves` precedent — no UPDATE/DELETE policy, and no `is_platform()` SELECT grant, extending the same exclusion already applied to `members`/`signed_contracts`/`signatures`: a dispense order links a specific member to specific cannabis products, at least as sensitive as a signed contract):

```sql
alter table dispense_orders enable row level security;

create policy dispense_orders_select on dispense_orders for select to authenticated
  using (club_id in (select my_club_ids()));

create policy dispense_orders_insert on dispense_orders for insert to authenticated
  with check (club_id in (select my_club_ids()));
```

## Checkout Function

`create_dispense_order(p_club_id uuid, p_member_id uuid, p_items jsonb)` — same `security invoker` atomic-transaction pattern as `record_donation`. `p_items` is a JSON array of `{product_id, qty}`.

In one transaction, entirely server-side (client-side gating in the UI is a UX convenience, never the enforcement point — matching this project's established "server re-verifies, never trusts the client" convention):

1. Reject an empty item list.
2. Verify the member being dispensed to belongs to `p_club_id` (defense-in-depth — `dispense_orders`' own INSERT policy only checks its own `club_id`, never cross-validates `member_id`).
3. Resolve the CALLING staff member's own identity via `auth.uid()` + a `club_users` lookup scoped to `p_club_id` (same pattern as `record_donation`'s `staff_id` resolution) — this both supplies `dispense_orders.staff_id` and independently verifies the caller themselves belongs to this club, not just the member being dispensed to.
4. For every line: verify the product belongs to `p_club_id`, verify **requested qty does not exceed current derived stock** (`sum(inventory_moves.qty)` for that product) — the mock never enforced this at all; it's an obvious correctness requirement (you cannot dispense product you don't have), not a new design decision. Accumulate the token total and the JSON snapshot as it goes.
5. Verify the member's `token_balance` covers the accumulated total.
6. Insert the `dispense_orders` row (with the computed total + snapshot + resolved `staff_id`).
7. Insert one `SALE` `inventory_moves` row per line (negative qty, `order_id` set to the new order's id, `staff_id` set to the same resolved value).
8. Decrement `members.token_balance` by the total.
9. Return the created order.

Any failure at any step (insufficient stock, insufficient tokens, unknown product, unknown member) raises an exception, rolling back every write from this call — a partially-completed dispense (stock decremented but tokens not debited, or vice versa) is impossible.

## Data Layer

### `src/lib/dispensing.ts` (new)

```ts
export type CartItem = { productId: string; qty: number };

export type DispenseOrderItem = {
  productId: string;
  productName: string;
  unit: string;
  qty: number;
  tokenPrice: number;
  lineTotal: number;
};

export type DispenseOrder = {
  id: string;
  memberId: string;
  tokenTotal: number;
  items: DispenseOrderItem[];
  createdAt: string;
};

export async function createDispenseOrder(
  supabase: SupabaseClient,
  clubId: string,
  memberId: string,
  items: CartItem[],
): Promise<DispenseOrder>;
```

Calls `supabase.rpc("create_dispense_order", {...})`. As with `record_donation`, the function returns a single composite row (not `setof`), so `data` comes back as one object, not an array.

No new read function is needed for the product grid or member list — this screen reuses `getProducts` (`src/lib/products.ts`) and `listMembers` (`src/lib/members.ts`) exactly as they exist.

## Screen

Same Server Component + Client Component split as every prior screen.

- `src/app/[clubSlug]/dispense/page.tsx` — `resolveClubAccess` + `notFound()`, `getProducts` and `listMembers` in parallel, renders header + panel.
- `src/app/[clubSlug]/dispense/dispensing-header.tsx` — title "Dispensing", subtitle "Redeem member tokens for product" (the mock's own copy).
- `src/app/[clubSlug]/dispense/dispensing-panel.tsx` (and any sub-components the implementation plan splits out, given this is the largest screen so far) — Client Component:
  - **Member picker**: a search input that filters the passed-in member list by name/code as the staff types; selecting a result shows the member's name, code, and current token balance, with a "Change" affordance to pick someone else. Until a member is selected, the product grid still renders (so staff can browse) but checkout stays disabled.
  - **Category filter chips**: All / Flower / Pre-rolls / Edibles / Concentrate / Accessory, filtering the product grid client-side (matches Products' filter-chip pattern).
  - **Product grid**: every active product (not just in-stock ones — the mock doesn't hide zero-stock products either; the server-side stock check is what actually prevents over-dispensing). Tapping a product adds one unit to the cart.
  - **Cart panel**: line items with qty +/− controls, running token total, item count, "Balance after" preview (`member.tokenBalance - cartTotal`, styled red if negative). "Confirm dispense" is disabled until: a member is selected, the cart has at least one item, and balance-after is non-negative — mirroring the mock's own gating logic, purely client-side UX (the function re-checks everything server-side regardless).
  - On successful checkout: clear the cart, clear the selected member (matching the mock's own reset-after-dispense behavior, which makes sense for a counter workflow — the next customer needs a fresh pick), show a success toast ("Dispensed · {count} item(s), {balance} tokens remaining", matching the mock's copy), and refresh the product list's stock figures so the grid reflects the new stock levels without a full page reload (re-fetch `getProducts` client-side via a server action, or decrement locally from the known cart deltas — the plan should pick whichever is simpler and still correct).

## Testing

- `tests/dispensing.test.ts`, live Supabase, reusing `tests/rls/fixtures.ts`. Covers: a successful multi-line order debits the exact token total and creates matching `SALE` inventory_moves rows (stock decreases by the right amount); rejects when requested qty exceeds current stock; rejects when the member's token balance is insufficient for the order total; rejects a product belonging to a different club (defense-in-depth); rejects a member belonging to a different club; the whole order rolls back on any single line's failure (a two-line order where line 2 is invalid must leave stock/tokens/order-count completely unchanged from line 1 — proving atomicity, not just testing each failure mode in isolation).
- UI verified via `tsc`/`build`/manual smoke test only, per this project's established convention.

## Global Constraints

- Reuse `src/lib/supabase/server.ts`, `src/lib/auth/club-access.ts`'s `resolveClubAccess`, `src/lib/page-header-context.tsx`'s `usePageHeader`, `src/lib/toast-context.tsx`'s `useToast`, `src/lib/products.ts`'s `getProducts`, `src/lib/members.ts`'s `listMembers` exactly as they exist — do not modify any of them.
- No PostgREST relation embedding anywhere.
- No shadcn/`@base-ui/react` components — hand-rolled Tailwind markup, matching every prior screen.
- Every labeled form field needs `htmlFor`/`id` pairing.
- Migration files follow the existing `YYYYMMDDHHMMSS_description.sql` naming, applied via `supabase db push --linked` against the live linked project (ref `inlseklfbptgjketdnpe`).
- pnpm exclusively, Node via `.nvmrc`, commit messages plain/imperative, work on branch `master` directly (standing consent from all prior phases).
