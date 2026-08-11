# Bulk / Quantity-Based Pricing — Design Spec

**Status:** Approved
**Scope:** New feature for GaafD, not tied to the original mock (the mock has no concept of quantity discounts — confirmed via full-codebase grep, zero hits for discount/bulk/tier anywhere). Triggered by a real customer request: Cottonmouth's owner wants standard cannabis-retail bulk pricing (e.g. "1g = R150, but 10g+ = R100/g").

## Context

`products.token_price` is today a single flat per-unit price (`src/lib/products.ts`). The Dispensing checkout function (`create_dispense_order`, most recently modified in `supabase/migrations/20260801120000_fix_dispense_order_duplicate_products.sql`) computes each cart line as `token_price * qty` with no notion of a quantity break. Since this app's tokens map 1:1 to Rand via donations, `token_price` already IS the Rand price per unit.

Cottonmouth is a live, real customer already using the app — this feature must not disrupt any of Ricardo's existing products or data.

## Requirements (confirmed with the user)

- Admin configures bulk pricing per product, as one or more quantity breaks: at or above `minQty` units, the price becomes `unitPrice` per unit for the **whole** line (not graduated/marginal — crossing the threshold reprices the entire quantity, not just the units above it).
- Tiers are editable and removable later, same as any other product field — no separate "manage discounts" screen, just part of the existing edit-product flow.
- Existing live products must be unaffected: every current product gets an implicit "no tiers" state and keeps behaving exactly as it does today until an admin deliberately adds a tier.
- Staff should see the bulk price on the product card in Dispensing (not just silently in the cart), and the cart's line total should live-update to the discounted rate the moment quantity crosses a threshold.

## Schema

One new column, additive and safe for a live table:

```sql
alter table products add column price_tiers jsonb not null default '[]'::jsonb;
```

`not null default '[]'::jsonb` means Postgres backfills every existing row (including all of Cottonmouth's live products) with an empty array at add-time — a metadata-only operation, not a table rewrite. No existing product's behavior changes until someone edits it to add a tier. No RLS policy changes needed — `price_tiers` is just another column on a row already covered by the existing `products` policies (now role-aware, per the prior RBAC feature).

Shape: `price_tiers` is a JSON array of `{ "minQty": number, "unitPrice": number }` objects, both whole numbers (matching every other price field in this app — no decimals). Order doesn't need to be pre-sorted in storage; the price-lookup logic (below) sorts at read time.

## Price Resolution

One rule, implemented identically in SQL and TypeScript so they can never disagree: **given a quantity, find the highest-`minQty` tier whose `minQty` is ≤ that quantity; if none qualifies, use the product's normal `token_price`.**

New SQL helper, `supabase/migrations/20260811160000_bulk_pricing.sql` (same migration as the schema change above):

```sql
create or replace function effective_unit_price(p_base_price integer, p_tiers jsonb, p_qty integer)
returns integer
language sql
immutable
as $$
  select coalesce(
    (
      select (tier->>'unitPrice')::integer
      from jsonb_array_elements(coalesce(p_tiers, '[]'::jsonb)) as tier
      where (tier->>'minQty')::integer <= p_qty
      order by (tier->>'minQty')::integer desc
      limit 1
    ),
    p_base_price
  );
$$;
```

`immutable` because the result depends only on its inputs — lets the planner treat it as a pure function, and it can never touch RLS-governed tables since it takes plain scalars/jsonb, not row references.

## Checkout Function Change

`create_dispense_order` already aggregates duplicate cart lines of the same product into one combined quantity before doing any per-line pricing (from the earlier duplicate-product-lines fix) — the tier lookup slots into that exact point, so a two-line order of the same product (e.g. 4g + 6g) still correctly prices the combined 10g against the 10g+ tier. New migration `create or replace function`s the existing function, changing only the price-lookup line:

Where the function currently does (paraphrased from the live version):
```sql
select p.name, p.unit, p.token_price into v_product_name, v_unit, v_token_price
from products p
where p.id = v_product_id and p.club_id = p_club_id;
```

it becomes (selecting the new column too, then resolving the effective price before it's used):
```sql
select p.name, p.unit, p.token_price, p.price_tiers into v_product_name, v_unit, v_token_price, v_price_tiers
from products p
where p.id = v_product_id and p.club_id = p_club_id;
...
v_token_price := effective_unit_price(v_token_price, v_price_tiers, v_qty);
```
placed after the stock-sufficiency check (so an under-stock order still fails on stock, not on a price calculated for a quantity that can't be fulfilled) and before `v_token_total := v_token_total + (v_token_price * v_qty)`. This is the only change to the function's logic — atomicity, defense-in-depth checks, and the duplicate-aggregation fix are all untouched.

## Data Layer

`src/lib/products.ts`:
- `Product`, `ProductRow`, `ProductInput` all gain `priceTiers: PriceTier[]` / `price_tiers` respectively, where `export type PriceTier = { minQty: number; unitPrice: number };`.
- `PRODUCT_COLUMNS` gains `price_tiers`.
- `mapProduct` maps `row.price_tiers ?? []` to `priceTiers`.
- `createProduct`/`updateProduct` write `price_tiers: input.priceTiers` in their insert/update payloads.
- New pure function `export function effectiveUnitPrice(basePrice: number, tiers: PriceTier[], qty: number): number` — the TypeScript twin of the SQL helper, same rule, used by the Dispensing cart's live total (never used to *decide* what gets charged — the RPC is still the sole enforcement point, this is UX preview only, matching this app's established "server re-verifies, never trusts the client" convention).

`src/lib/dispensing.ts` is untouched — `createDispenseOrder`'s request/response shape doesn't change; the price resolution happens entirely server-side inside the RPC.

## UI

**Products create/edit modal** (`src/app/[clubSlug]/products/products-table.tsx`): new "Bulk pricing" section — a repeatable list of `{minQty, unitPrice}` rows with add/remove controls, below the existing price fields. Validation: both values must be positive whole numbers; no cross-tier validation (e.g. not enforcing that tier prices are actually cheaper than the base, or that quantities are unique/ascending — an admin entering a nonsensical tier is a data-entry mistake they'll notice themselves, not worth the added complexity of enforcing).

**Dispensing product grid** (`src/app/[clubSlug]/dispense/dispensing-panel.tsx`): each card showing at least one tier gets a small hint line under the base price, e.g. "R150/g · 10g+: R100/g" (all configured tiers shown, comma-separated, ascending by `minQty`). Products with an empty `price_tiers` array show exactly as they do today — no layout change.

**Dispensing cart**: each line's displayed unit price and line total switch to `effectiveUnitPrice(product.tokenPrice, product.priceTiers, line.qty)` instead of the flat `product.tokenPrice`, live-updating on every qty +/- click — same live-recompute pattern already used for the cart total and balance-after preview.

## Testing

- `tests/products.test.ts`: `createProduct`/`updateProduct` round-trip `priceTiers` correctly (empty array by default, non-empty array preserved through create and edit).
- `tests/dispensing.test.ts`: new cases — a product with no tiers checks out at the flat price (regression, proving untouched products behave identically); a product with a tier checks out at the base price below the threshold and at the tier price at/above it; a two-line order of the same product whose *combined* quantity crosses a threshold that neither line crosses individually prices correctly at the tier rate (proving the aggregation-then-price-lookup interaction works, not just single-line tiering).
- UI verified via `tsc`/`build`/manual smoke test only, per this project's established convention.

## Global Constraints

- Reuse `src/lib/supabase/server.ts`, `src/lib/auth/require-role.ts`'s `assertClubAdmin`, `src/lib/toast-context.tsx`'s `useToast` exactly as they exist — do not modify any of them. Do not modify `src/lib/dispensing.ts` or the RPC's parameter/return shape — this feature only changes what happens *inside* the existing function, not its interface.
- No PostgREST relation embedding anywhere.
- No shadcn/`@base-ui/react` components — hand-rolled Tailwind, matching every prior screen.
- Every labeled form field needs `htmlFor`/`id` pairing.
- Migration files follow the existing `YYYYMMDDHHMMSS_description.sql` naming, applied via `supabase db push --linked` against the live linked project (ref `inlseklfbptgjketdnpe`) — this is a live project with real customer data, so the migration must be verified with `--dry-run` first and its column-add confirmed additive/non-destructive before applying, same discipline as every prior migration in this project but worth restating given Cottonmouth is now live.
- pnpm exclusively, Node via `.nvmrc`, commit messages plain/imperative, work on branch `master` directly (standing consent from all prior phases).
