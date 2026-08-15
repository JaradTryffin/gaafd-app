# Dispensing Gifts — Design Spec

**Status:** Approved
**Scope:** New feature for GaafD. Wires up the `gift` product flag's original apparent intent — it exists on Products today ("Gifting allowed" checkbox) but is purely decorative, never read by Dispensing or the checkout function. Triggered by a real request from the owner: staff need to be able to give a customer a free item at checkout (e.g. 1g of Durban Poison) without charging tokens for it.

## Context

`create_dispense_order` (most recently modified for bulk-pricing tiers in `supabase/migrations/20260811160100_bulk_pricing_functions.sql`) will be modified a fourth time by this feature — the same low-risk `create or replace function` pattern used for the duplicate-product-lines fix and the bulk-pricing tiers, each time reviewed with the same heightened scrutiny this project always gives its real-money/real-inventory checkout path.

## Requirements (confirmed with the user)

- Gifting is per cart line, not the whole order — one item in an otherwise-normal order can be marked as a gift.
- Any staff or admin can gift, no limit — matches Dispensing's existing unrestricted staff access; accountability comes from the existing per-order `staff_id` audit trail, not a new permission gate.
- Any product is giftable — the existing "Gifting allowed" flag is NOT wired into this; it stays decorative.
- A gift line has an optional reason field (not required).
- A gifted item still decrements stock (it physically left the shop) but is excluded from the order's token total (the member's balance is never touched for it). A member can receive an all-gift order even at 0 balance.

## Schema

**None.** This is the first feature in this project's history that needs zero schema changes — everything is carried through the existing `p_items`/`items` JSONB columns on `create_dispense_order`/`dispense_orders`, which already have no fixed shape beyond what the function itself reads and writes.

## Checkout Function Change

One migration, `create or replace function create_dispense_order` (same signature, same `returns dispense_orders`). Three changes to the current live body, nothing else touched — not the aggregation logic's existing behavior for `qty`, not the atomicity, not the defense-in-depth checks:

1. **Raw per-line reads** gain `is_gift`/`gift_reason` extraction (defaulting `is_gift` to `false` when absent, so a caller that never mentions gifting at all — matching every dispense order created before this feature shipped — behaves identically to today).
2. **The aggregation step** (which already collapses duplicate `product_id` lines into one combined quantity, from the earlier duplicate-lines fix) additionally aggregates `is_gift` via `bool_or` (if ANY line for a product was marked gift, the combined line is treated as a gift — the conservative "if in doubt, don't charge" default) and `gift_reason` via `max` (an arbitrary but deterministic pick). Both are structurally unreachable from the real UI today, since the cart is one line per product — documented the same way the bulk-pricing tier aggregation edge case was documented, not because it needs elaborate handling.
3. **The main pricing loop**: after resolving `v_token_price` (unchanged — a gifted line's `tokenPrice`/would-be `lineTotal` are still computed and stored, preserving the retail-equivalent value for the record), the amount actually added to `v_token_total` is `0` for a gift line instead of `v_token_price * v_qty`. The snapshot gains `isGift`/`giftReason` fields per line. The second loop (inventory_moves inserts) is completely unchanged — a gifted line still gets its `SALE` row with the real negative quantity, because the product left inventory either way.

Full new body:

```sql
create or replace function create_dispense_order(
  p_club_id uuid,
  p_member_id uuid,
  p_items jsonb
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

    select p.name, p.unit, p.token_price, p.price_tiers into v_product_name, v_unit, v_token_price, v_price_tiers
    from products p
    where p.id = v_product_id and p.club_id = p_club_id;

    if v_product_name is null then
      raise exception 'Product not found in this club';
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

  insert into dispense_orders (club_id, member_id, token_total, items, staff_id)
  values (p_club_id, p_member_id, v_token_total, v_snapshot, v_staff_id)
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

`lineTotal` keeps its established meaning across this whole app — "what this line is worth" — unchanged by gift status. The order-level `token_total` remains the single source of truth for "what was actually deducted," now correctly excluding gift lines. No new field is needed to distinguish "retail value" from "amount charged" beyond `lineTotal` (always retail-equivalent, per line) vs `token_total` (always actual, per order) — that distinction already existed in spirit, this feature just makes it possible for the two to legitimately diverge.

## Data Layer

`src/lib/dispensing.ts`:

```ts
export type CartItem = { productId: string; qty: number; isGift?: boolean; giftReason?: string | null };

export type DispenseOrderItem = {
  productId: string;
  productName: string;
  unit: string;
  qty: number;
  tokenPrice: number;
  lineTotal: number;
  isGift: boolean;
  giftReason: string | null;
};
```

`isGift`/`giftReason` on `CartItem` (the input type) are optional — every existing call site across `tests/dispensing.test.ts` constructs items as `{productId, qty}` with no gift fields at all, and making them required would force a mechanical edit of every one of those pre-existing call sites for no behavioral benefit (the same unnecessary-breakage class of issue already hit and avoided in the bulk-pricing and role-based-access features). `DispenseOrderItem` (the RPC's returned snapshot shape) keeps both fields required and non-optional — the SQL function always builds both into every snapshot entry regardless of what was sent, so the response shape is always fully populated.

`createDispenseOrder`'s `p_items` mapping becomes `is_gift: i.isGift ?? false, gift_reason: i.giftReason ?? null`. `DispenseOrder`/`DispenseOrderRow` and the rest of the function are unchanged — the composite-row return shape doesn't change.

## UI

`src/app/[clubSlug]/dispense/dispensing-panel.tsx`:

- New state `giftLines: Record<string, string>` — a product id's presence as a key means that cart line is marked as a gift; the value is its (possibly empty) reason. Layered alongside the existing `cart: Record<string, number>` qty state, not merged into it — keeps the existing `addToCart`/`changeQty` logic untouched.
- `cartLines` gains `isGift`/`giftReason` (derived from `giftLines`) and `chargedTotal` (`0` if `isGift`, else `lineTotal`). `cartTotal` sums `chargedTotal` instead of `lineTotal` — this is what actually gets deducted, so `balanceAfter`/`canCheckout` (both already derived from `cartTotal`) need no further changes; a member with 0 tokens can check out an all-gift cart because `cartTotal` correctly comes out to `0`.
- Each cart line gets a small "🎁" toggle button. Toggling it on shows an optional reason `<input>` beneath that line and switches the line's displayed price to a struck-through style (still shows the retail-equivalent number, visually marked as not-charged, matching the design's earlier "obviously not a normal sale at a glance" requirement). Toggling off removes the line from `giftLines` and its reason.
- `handleCheckout`'s `items` mapping sends `isGift`/`giftReason` per line to `createDispenseOrderAction`.
- A small summary line appears in the cart footer when any line is gifted (e.g. "Includes 1 gift") — cheap, keeps staff aware before confirming.

## Testing

- `tests/dispensing.test.ts`: a gift-only order (single line, `isGift: true`) checks out at `tokenTotal: 0`, decrements stock by the gifted quantity, and leaves the member's `token_balance` unchanged. A mixed order (one paid line + one gift line) charges only the paid line's value while both lines decrement stock and both appear in the snapshot with correct `isGift` flags. A gift order succeeds even when the member's balance is `0` (proving the balance check correctly uses the gift-excluded total, not a pre-gift total). Regression: an order with no gift lines at all behaves byte-for-byte as it did before this feature (existing tests already cover this implicitly by never setting `isGift`, but add one explicit case confirming a normal order's snapshot items have `isGift: false`).
- UI verified via `tsc`/`build`/manual smoke test only, per this project's established convention.

## Global Constraints

- Reuse `src/lib/supabase/server.ts`, `src/lib/toast-context.tsx`'s `useToast` exactly as they exist — do not modify either. Do not modify `src/lib/products.ts` or the "Gifting allowed" product flag — this feature deliberately leaves that flag decorative.
- No PostgREST relation embedding anywhere.
- No shadcn/`@base-ui/react` components — hand-rolled Tailwind, matching every prior screen.
- Every labeled form field needs `htmlFor`/`id` pairing.
- Migration files follow the existing `YYYYMMDDHHMMSS_description.sql` naming, applied via `supabase db push --linked` against the live linked project (ref `inlseklfbptgjketdnpe`) — Cottonmouth is an active trial customer using Dispensing regularly, so this migration (like every prior `create_dispense_order` change) needs the same live verification discipline even though it's function-only, not a destructive schema change.
- pnpm exclusively, Node via `.nvmrc`, commit messages plain/imperative, work on branch `master` directly (standing consent from all prior phases).
