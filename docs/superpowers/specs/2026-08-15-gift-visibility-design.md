# Gift Visibility & Flag Enforcement — Design Spec

**Status:** Approved
**Scope:** Two follow-ups from the Dispensing Gifts feature's final review, addressed together: (1) an admin-only Order History screen so gifts (and all checkouts) are actually visible without raw SQL, (2) enforcing the "Gifting allowed" product flag so it stops implying a control that doesn't exist.

## Context

`dispense_orders` (`isGift`/`giftReason` per item, `staff_id`, `created_at`) is read nowhere in this app except the create wrapper in `src/lib/dispensing.ts` — confirmed via the Dispensing Gifts final review. `products.flags` already has a `gift` value ("Gifting allowed" checkbox in the Products editor) that has never been read by Dispensing's gift toggle, which currently applies to any product.

## Requirements (confirmed with the user)

- The "Gifting allowed" flag becomes a real restriction: Dispensing's gift toggle only appears for flagged products, enforced both client-side and server-side.
- New Order History screen: every checkout ever made (not just gifts), newest first, with a "Gifts only" filter chip. Admin-only, matching Dashboard's existing access pattern.
- Capped to the most recent 200 orders — no pagination needed yet, matching this app's existing lightweight-list precedent (Inventory's ledger, Donations' list).

## Schema

One additive column, needed because `dispense_orders` currently has no readable staff identity beyond an opaque `staff_id` (a `club_users.id` that RLS won't let another user resolve to an email) — the same gap `inventory_moves.staff_email`/`shifts.staff_email` already solved for their own screens:

```sql
alter table dispense_orders add column staff_email text;
```

Nullable — existing orders predate this column and will show no staff attribution on the new screen (acceptable; this is new visibility, not a promise of complete history). Every order created after this migration gets it populated.

## Checkout Function Change (5th modification to `create_dispense_order`)

Two changes, same `create or replace function` pattern as every prior change, same dedicated heightened-scrutiny review:

1. **New parameter** `p_staff_email text`, following the exact pattern already established by `till.ts`'s `clockIn`/`closeBusinessDay` (this codebase cannot query `auth.users` directly in SQL — the caller resolves email via `supabase.auth.getUser()` client-side and passes it in). Written into the `dispense_orders` insert.
2. **Gift-flag enforcement**: the per-line product lookup now also selects `p.flags`. If a line is marked `is_gift` and the product's `flags` array doesn't contain `'gift'`, the function raises an exception naming the product — before any write, alongside the existing stock/balance checks.

Full new body:

```sql
create or replace function create_dispense_order(
  p_club_id uuid,
  p_member_id uuid,
  p_items jsonb,
  p_staff_email text
)
returns dispense_orders
language plpgsql
security invoker
as $$
declare
  v_order dispense_orders;
  v_item jsonb;
  v_product_id uuid;
  v_qty integer;
  v_token_price integer;
  v_product_name text;
  v_unit text;
  v_flags text[];
  v_stock integer;
  v_token_total integer := 0;
  v_snapshot jsonb := '[]'::jsonb;
  v_member_balance integer;
  v_staff_id uuid;
  v_items_agg jsonb;
  v_price_tiers jsonb;
  v_is_gift boolean;
  v_gift_reason text;
  v_line_charge integer;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'Order must contain at least one item';
  end if;

  if not exists (select 1 from members where id = p_member_id and club_id = p_club_id) then
    raise exception 'Member not found in this club';
  end if;

  select cu.id into v_staff_id
  from club_users cu
  where cu.club_id = p_club_id and cu.user_id = auth.uid();
  if v_staff_id is null then
    raise exception 'Not a member of this club';
  end if;

  select token_balance into v_member_balance from members where id = p_member_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    if (v_item->>'product_id') is null then
      raise exception 'Invalid product for a line item';
    end if;
    v_qty := (v_item->>'qty')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Invalid quantity for a line item';
    end if;
  end loop;

  select jsonb_agg(jsonb_build_object(
    'product_id', product_id,
    'qty', qty,
    'is_gift', is_gift,
    'gift_reason', gift_reason
  ))
  into v_items_agg
  from (
    select
      (item->>'product_id')::uuid as product_id,
      sum((item->>'qty')::integer) as qty,
      bool_or(coalesce((item->>'is_gift')::boolean, false)) as is_gift,
      max(item->>'gift_reason') as gift_reason
    from jsonb_array_elements(p_items) as item
    group by (item->>'product_id')::uuid
  ) agg;

  for v_item in select * from jsonb_array_elements(v_items_agg)
  loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'qty')::integer;
    v_is_gift := coalesce((v_item->>'is_gift')::boolean, false);
    v_gift_reason := v_item->>'gift_reason';

    select p.name, p.unit, p.token_price, p.price_tiers, p.flags into v_product_name, v_unit, v_token_price, v_price_tiers, v_flags
    from products p
    where p.id = v_product_id and p.club_id = p_club_id;

    if v_product_name is null then
      raise exception 'Product not found in this club';
    end if;

    if v_is_gift and not ('gift' = any(coalesce(v_flags, '{}'::text[]))) then
      raise exception '% is not marked as giftable', v_product_name;
    end if;

    select coalesce(sum(im.qty), 0) into v_stock
    from inventory_moves im
    where im.product_id = v_product_id and im.club_id = p_club_id;

    if v_stock < v_qty then
      raise exception 'Insufficient stock for %', v_product_name;
    end if;

    v_token_price := effective_unit_price(v_token_price, v_price_tiers, v_qty);

    if v_is_gift then
      v_line_charge := 0;
    else
      v_line_charge := v_token_price * v_qty;
    end if;

    v_token_total := v_token_total + v_line_charge;
    v_snapshot := v_snapshot || jsonb_build_object(
      'productId', v_product_id,
      'productName', v_product_name,
      'unit', v_unit,
      'qty', v_qty,
      'tokenPrice', v_token_price,
      'lineTotal', v_token_price * v_qty,
      'isGift', v_is_gift,
      'giftReason', v_gift_reason
    );
  end loop;

  if v_member_balance < v_token_total then
    raise exception 'Member does not have enough tokens for this order';
  end if;

  insert into dispense_orders (club_id, member_id, token_total, items, staff_id, staff_email)
  values (p_club_id, p_member_id, v_token_total, v_snapshot, v_staff_id, p_staff_email)
  returning * into v_order;

  for v_item in select * from jsonb_array_elements(v_items_agg)
  loop
    insert into inventory_moves (club_id, product_id, type, qty, order_id, staff_id)
    values (
      p_club_id,
      (v_item->>'product_id')::uuid,
      'SALE',
      -((v_item->>'qty')::integer),
      v_order.id,
      v_staff_id
    );
  end loop;

  update members set token_balance = token_balance - v_token_total
  where id = p_member_id and club_id = p_club_id;

  return v_order;
end;
$$;
```

The gift-flag check runs alongside the other per-line validations, before any write — same "validate everything before any write" ordering this function has always had. The `bool_or`/`max` aggregation of `is_gift`/`gift_reason` (from the previous change) is unaffected; the new check simply runs after aggregation resolves which combined line is a gift, exactly like every other per-line check in this loop.

## Data Layer

### `src/lib/dispensing.ts` changes

`createDispenseOrder` resolves the caller's email via `supabase.auth.getUser()` (matching `till.ts`'s `clockIn` pattern) and passes it as `p_staff_email`. `DispenseOrder`/`DispenseOrderRow` gain `staffEmail: string | null`.

### `src/lib/dispense-orders.ts` (new)

```ts
export type DispenseOrderHistoryItem = {
  productId: string;
  productName: string;
  unit: string;
  qty: number;
  tokenPrice: number;
  lineTotal: number;
  isGift: boolean;
  giftReason: string | null;
};

export type DispenseOrderHistoryRow = {
  id: string;
  memberId: string;
  memberName: string;
  staffEmail: string | null;
  tokenTotal: number;
  items: DispenseOrderHistoryItem[];
  hasGift: boolean;
  createdAt: string;
};

export async function getDispenseOrders(
  supabase: SupabaseClient,
  clubId: string,
  filters?: { giftsOnly?: boolean },
): Promise<DispenseOrderHistoryRow[]>;
```

Reads `dispense_orders` (`id, member_id, staff_email, token_total, items, created_at`), ordered newest-first, capped at 200 rows. Resolves `memberName` via the established two-query no-embedding pattern (batched `.in(...)` on `members`, matching `getTodaysDonations`). Product names are NOT re-resolved — each order's `items` snapshot already has `productName` denormalized from checkout time, exactly like every other consumer of this snapshot. `hasGift` is derived in-memory (`items.some(i => i.isGift)`); `giftsOnly` filters the mapped list before returning.

### `src/lib/products.ts`

No changes — `flags: string[]` already exists on `Product`/`ProductInput`.

## UI

**Dispensing** (`src/app/[clubSlug]/dispense/dispensing-panel.tsx`): the 🎁 toggle button on a cart line only renders when that line's product has `flags.includes('gift')`. A non-giftable product's cart line shows no toggle at all (not a disabled/grayed one) — simplest, no explanatory tooltip needed since the absence itself is unambiguous once an admin knows the flag exists.

**New Order History screen** (`src/app/[clubSlug]/orders/`, admin-only — gated the same way as Products/Dashboard, `if (access.role !== "admin") notFound();`):
- `page.tsx` — `resolveClubAccess` + admin gate, calls `getDispenseOrders`.
- `orders-header.tsx` — title "Order history", subtitle "Every checkout, including gifts".
- `orders-table.tsx` — Client Component: "All" / "Gifts only" filter chips (matching Inventory's chip pattern), a list of orders (staff email, member name, item count, token total, relative time — matching `formatRelativeTime` already used on Dashboard), each row expandable or simply listing its item names inline (gift lines visually marked, e.g. a small "🎁" next to a gifted item's name within the row). Empty state: "No orders yet."

**Sidebar** (`src/components/app-shell/sidebar.tsx`): new entry in the "Accounting" group, alongside Donations and Till & shifts:

```ts
{ key: "orders", label: "Order history", path: "/orders", dot: "var(--tenant-accent-5)", adminOnly: true },
```

## Testing

**Breaking-change alert requiring a fixture update (must land first):** `products.flags` defaults to `'{}'` (empty array — `supabase/migrations/20260727130000_core_schema.sql:60`), and `tests/dispensing.test.ts`'s shared `seedProduct(clubId, tokenPrice, stock)` helper never sets it. This means every one of the 4 existing gift tests from the Dispensing Gifts feature (which mark lines `isGift: true` against a `seedProduct()`-created product) would start failing the instant flag-enforcement ships, because their test products were never flagged giftable. `seedProduct` needs a 4th, optional parameter — `flags: string[] = []` — so every existing non-gift call site (the large majority of this file's tests) keeps compiling and behaving identically, while the 4 pre-existing gift tests and any new ones pass `['gift']` explicitly.

- `tests/dispensing.test.ts`: the 4 existing gift tests updated to seed their product with `flags: ['gift']` (via the updated `seedProduct` helper) so they continue passing under the new enforcement. New case: a gift line for a product WITHOUT the `gift` flag is rejected with the new error message. New case: a gift line for a product WITH the flag succeeds (this doubles as regression coverage, since it's functionally identical to what the 4 existing tests now do). `staffEmail` is present and correct on a newly created order.
- `tests/dispense-orders.test.ts` (new): `getDispenseOrders` returns orders newest-first, resolves member names correctly, cross-tenant isolation (club B's orders never appear for club A), `giftsOnly` filter correctly includes only orders with at least one gift line and excludes orders with none.
- UI verified via `tsc`/`build`/manual smoke test only, per this project's established convention.

## Global Constraints

- Reuse `src/lib/supabase/server.ts`, `src/lib/auth/club-access.ts`'s `resolveClubAccess`, `src/lib/page-header-context.tsx`'s `usePageHeader`, `src/lib/format.ts`'s `formatRelativeTime` exactly as they exist — do not modify any of them.
- No PostgREST relation embedding anywhere.
- No shadcn/`@base-ui/react` components — hand-rolled Tailwind, matching every prior screen.
- Every labeled form field needs `htmlFor`/`id` pairing.
- Migration files follow the existing `YYYYMMDDHHMMSS_description.sql` naming, applied via `supabase db push --linked` against the live linked project (ref `inlseklfbptgjketdnpe`) — Cottonmouth is an active trial customer using Dispensing regularly; this is the 5th live modification to `create_dispense_order`, same verification discipline as every prior one.
- pnpm exclusively, Node via `.nvmrc`, commit messages plain/imperative, work on branch `master` directly (standing consent from all prior phases).
