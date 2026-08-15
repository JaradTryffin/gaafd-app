# Dispensing Gifts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff mark a Dispensing cart line as a gift — the item still decrements stock and is fully recorded, but the member's token balance is never charged for it.

**Architecture:** No schema changes — everything rides on the existing JSONB `p_items`/`items` shape on `create_dispense_order`/`dispense_orders`. Three tasks: the checkout function change (this project's highest-risk file, 4th modification, own dedicated review gate), then the data layer + tests, then the UI.

**Tech Stack:** Next.js App Router, TypeScript, Supabase JS client (`.rpc()`), PL/pgSQL, Vitest.

## Global Constraints

- Reuse `src/lib/supabase/server.ts`, `src/lib/toast-context.tsx`'s `useToast` exactly as they exist — do not modify either. Do not modify `src/lib/products.ts` or the "Gifting allowed" product flag — this feature deliberately leaves that flag decorative.
- No PostgREST relation embedding anywhere.
- No shadcn/`@base-ui/react` components — hand-rolled Tailwind, matching every prior screen.
- Every labeled form field needs `htmlFor`/`id` pairing.
- Migration files follow the existing `YYYYMMDDHHMMSS_description.sql` naming, applied via `supabase db push --linked` against the live linked project (ref `inlseklfbptgjketdnpe`) — Cottonmouth is an active trial customer using Dispensing regularly.
- pnpm exclusively, Node via `.nvmrc` (run `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use` before any command — fall back to `node_modules/.bin/tsc`/`node_modules/.bin/next`/`node_modules/.bin/vitest` directly if this environment's pnpm/corepack shim still breaks).
- Commit messages plain, imperative. Work on branch `master` directly (standing consent from all prior phases).
- `CartItem`/`DispenseOrderItem`/`DispenseOrder` (`src/lib/dispensing.ts`) and `Product`/`effectiveUnitPrice` (`src/lib/products.ts`) confirmed against the actual current files — no drift.

---

### Task 1: Migration — gift-aware `create_dispense_order`

**Files:**
- Create: `supabase/migrations/20260815180000_dispensing_gifts.sql`

**Interfaces:**
- Consumes: nothing new — same `create_dispense_order(p_club_id uuid, p_member_id uuid, p_items jsonb) returns dispense_orders` signature as the live function.
- Produces: `p_items` entries may now optionally include `is_gift`/`gift_reason` keys; the returned `dispense_orders.items` snapshot always includes `isGift`/`giftReason` per line, and `token_total` excludes gift lines.

This is the 4th modification to this project's most scrutinized function. The full body below is complete and final — transcribe it verbatim, do not regenerate any part of it from memory of the previous version.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260815180000_dispensing_gifts.sql`:

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

- [ ] **Step 2: Apply the migration**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use && supabase db push --linked`
Expected: applies cleanly.

- [ ] **Step 3: Verify nothing is left pending**

Run: `supabase db push --linked --dry-run`
Expected: no pending migrations listed.

- [ ] **Step 4: Verify `security invoker` is preserved**

```sql
select proname, prosecdef from pg_proc where proname = 'create_dispense_order';
```
Expected: one row, `prosecdef = false`.

- [ ] **Step 5: Backward-compatibility smoke test — an order with NO gift fields behaves exactly as before**

Using the service-role admin client, create a throwaway club with 1 product (stock 20, `token_price` 40) and 1 member (`token_balance` 500) — mirror `tests/rls/fixtures.ts`'s `seedClub` approach, not the shared fixture function itself (this club also needs one `product_categories` row, since `products.category_id` is required — insert one directly, e.g. `{name: 'Flower'}`, and reference its id on the product).

Call `create_dispense_order` with `p_items = [{"product_id": "...", "qty": 2}]` — no `is_gift`/`gift_reason` keys at all, exactly matching every dispense order created before this migration. Confirm it returns `token_total = 80`, `items[0].isGift = false`, `items[0].giftReason = null`, stock drops from 20 to 18, member balance drops from 500 to 420. This proves the migration is fully backward compatible with every existing caller.

- [ ] **Step 6: Gift smoke test**

In the same throwaway club, call `create_dispense_order` with `p_items = [{"product_id": "...", "qty": 1, "is_gift": true, "gift_reason": "Loyalty sample"}]`. Confirm `token_total = 0`, `items[0].isGift = true`, `items[0].giftReason = "Loyalty sample"`, `items[0].tokenPrice = 40` and `items[0].lineTotal = 40` (still the real retail value, just not charged), stock drops by 1 further (17), member balance unchanged from the previous step (420).

Delete the throwaway club afterward (cascades).

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260815180000_dispensing_gifts.sql
git commit -m "Add gift line support to create_dispense_order"
```

---

### Task 2: Data layer + tests

**Files:**
- Modify: `src/lib/dispensing.ts`
- Test: `tests/dispensing.test.ts`

**Interfaces:**
- Consumes: Task 1's gift-aware RPC.
- Produces: `CartItem.isGift?`/`CartItem.giftReason?` (both optional — every existing caller across this codebase constructs `CartItem` without them and must keep compiling unchanged), `DispenseOrderItem.isGift`/`DispenseOrderItem.giftReason` (both required, always present on the returned snapshot) — consumed by Task 3's UI.

- [ ] **Step 1: Update `src/lib/dispensing.ts`**

Change `CartItem` and `DispenseOrderItem`:

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

Change `createDispenseOrder`'s `p_items` mapping:

```ts
export async function createDispenseOrder(
  supabase: SupabaseClient,
  clubId: string,
  memberId: string,
  items: CartItem[],
): Promise<DispenseOrder> {
  const { data, error } = await supabase.rpc("create_dispense_order", {
    p_club_id: clubId,
    p_member_id: memberId,
    p_items: items.map((i) => ({
      product_id: i.productId,
      qty: i.qty,
      is_gift: i.isGift ?? false,
      gift_reason: i.giftReason ?? null,
    })),
  });
  if (error) throw error;
```

(The rest of `createDispenseOrder` — the composite-row cast and `DispenseOrder` construction — is unchanged. `DispenseOrder`/`DispenseOrderRow` types are unchanged.)

- [ ] **Step 2: Add gift tests to `tests/dispensing.test.ts`**

Add a new `describe` block (reuses this file's existing `seedProduct`/`seedMemberWithBalance`/`getStock`/`getBalance` helpers and `cleanupOrderIds` array exactly as they already exist):

```ts
describe("gifting", () => {
  it("checks out a gift-only order at tokenTotal 0, decrements stock, leaves balance unchanged", async () => {
    const product = await seedProduct(data.clubA.clubId, 150, 50);
    const member = await seedMemberWithBalance(data.clubA.clubId, 1000);

    const order = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: product.id, qty: 1, isGift: true, giftReason: "Loyalty" },
    ]);
    cleanupOrderIds.push(order.id);

    expect(order.tokenTotal).toBe(0);
    expect(order.items).toHaveLength(1);
    expect(order.items[0].isGift).toBe(true);
    expect(order.items[0].giftReason).toBe("Loyalty");
    expect(order.items[0].tokenPrice).toBe(150);
    expect(order.items[0].lineTotal).toBe(150);

    expect(await getStock(product.id)).toBe(49);
    expect(await getBalance(member.id)).toBe(1000);
  });

  it("charges only the paid line in a mixed paid+gift order, both lines decrement stock", async () => {
    const paidProduct = await seedProduct(data.clubA.clubId, 40, 50);
    const giftProduct = await seedProduct(data.clubA.clubId, 60, 30);
    const member = await seedMemberWithBalance(data.clubA.clubId, 1000);

    const order = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: paidProduct.id, qty: 2 },
      { productId: giftProduct.id, qty: 1, isGift: true, giftReason: null },
    ]);
    cleanupOrderIds.push(order.id);

    expect(order.tokenTotal).toBe(80);
    const paidItem = order.items.find((i) => i.productId === paidProduct.id);
    const giftItem = order.items.find((i) => i.productId === giftProduct.id);
    expect(paidItem?.isGift).toBe(false);
    expect(paidItem?.lineTotal).toBe(80);
    expect(giftItem?.isGift).toBe(true);
    expect(giftItem?.lineTotal).toBe(60);

    expect(await getStock(paidProduct.id)).toBe(48);
    expect(await getStock(giftProduct.id)).toBe(29);
    expect(await getBalance(member.id)).toBe(1000 - 80);
  });

  it("succeeds for an all-gift order even at zero balance", async () => {
    const product = await seedProduct(data.clubA.clubId, 200, 10);
    const member = await seedMemberWithBalance(data.clubA.clubId, 0);

    const order = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: product.id, qty: 1, isGift: true },
    ]);
    cleanupOrderIds.push(order.id);

    expect(order.tokenTotal).toBe(0);
    expect(await getStock(product.id)).toBe(9);
    expect(await getBalance(member.id)).toBe(0);
  });

  it("a normal order with no gift lines has isGift:false on every item (regression)", async () => {
    const product = await seedProduct(data.clubA.clubId, 40, 50);
    const member = await seedMemberWithBalance(data.clubA.clubId, 1000);

    const order = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: product.id, qty: 3 },
    ]);
    cleanupOrderIds.push(order.id);

    expect(order.items[0].isGift).toBe(false);
    expect(order.items[0].giftReason).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use && node_modules/.bin/vitest run tests/dispensing.test.ts`
Expected: all tests pass, including the 4 new `"gifting"` cases (11 total in the file).

- [ ] **Step 4: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dispensing.ts tests/dispensing.test.ts
git commit -m "Add gift fields to dispensing data layer and checkout tests"
```

---

### Task 3: UI — gift toggle in Dispensing cart

**Files:**
- Modify: `src/app/[clubSlug]/dispense/dispensing-panel.tsx`

**Interfaces:**
- Consumes: Task 2's `CartItem.isGift`/`giftReason` (optional).

- [ ] **Step 1: Add `giftLines` state**

Add this state declaration alongside the existing `cart` state:

```ts
  const [cart, setCart] = useState<Record<string, number>>({});
  const [giftLines, setGiftLines] = useState<Record<string, string>>({});
```

- [ ] **Step 2: Update `cartLines` to derive `isGift`/`giftReason`/`chargedTotal`, and `cartTotal` to sum `chargedTotal`**

Replace the existing `cartLines`/`cartTotal` block:

```ts
  const cartLines = Object.entries(cart).map(([productId, qty]) => {
    const product = productById.get(productId);
    const tokenPrice = product ? effectiveUnitPrice(product.tokenPrice, product.priceTiers, qty) : 0;
    const isGift = productId in giftLines;
    const lineTotal = tokenPrice * qty;
    return {
      productId,
      qty,
      name: product?.name ?? "—",
      tokenPrice,
      lineTotal,
      isGift,
      giftReason: giftLines[productId] ?? "",
      chargedTotal: isGift ? 0 : lineTotal,
    };
  });
  const cartCount = cartLines.reduce((sum, l) => sum + l.qty, 0);
  const cartTotal = cartLines.reduce((sum, l) => sum + l.chargedTotal, 0);
  const giftCount = cartLines.filter((l) => l.isGift).length;
```

(`balanceAfter`/`canCheckout` immediately below are unchanged — they already derive from `cartTotal`, which now correctly excludes gift lines.)

- [ ] **Step 3: Add gift toggle/reason handlers**

Add these functions alongside the existing `changeQty`/`selectMember` functions:

```ts
  function toggleGift(productId: string) {
    setGiftLines((prev) => {
      if (productId in prev) {
        const next = { ...prev };
        delete next[productId];
        return next;
      }
      return { ...prev, [productId]: "" };
    });
  }

  function setGiftReason(productId: string, reason: string) {
    setGiftLines((prev) => (productId in prev ? { ...prev, [productId]: reason } : prev));
  }
```

- [ ] **Step 4: Send `isGift`/`giftReason` at checkout, and reset `giftLines` after success**

Change `handleCheckout`'s `items` mapping and the post-success reset:

```ts
    const items = cartLines.map((l) => ({
      productId: l.productId,
      qty: l.qty,
      isGift: l.isGift,
      giftReason: l.giftReason || null,
    }));
    startCheckingOut(async () => {
      const result = await createDispenseOrderAction(clubId, selectedMember.id, items);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setProducts((prev) =>
        prev.map((p) => {
          const cartQty = cart[p.id];
          return cartQty ? { ...p, stock: p.stock - cartQty } : p;
        }),
      );
      showToast(
        `Dispensed · ${cartCount} item(s), ${selectedMember.tokenBalance - result.order.tokenTotal} tokens remaining`,
      );
      setCart({});
      setGiftLines({});
      setSelectedMemberId(null);
    });
```

- [ ] **Step 5: Update the cart line JSX — gift toggle button, reason input, struck-through price**

Replace the existing `cartLines.map((l) => (...))` block:

```tsx
            cartLines.map((l) => (
              <div key={l.productId} className="border-b border-[#f4f2ea] py-2.5">
                <div className="flex items-center gap-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{l.name}</div>
                    <div className="font-mono text-[11px] text-[#8a8e83]">
                      {l.tokenPrice} × {l.qty}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => changeQty(l.productId, -1)}
                      className="h-6 w-6 rounded-[6px] border border-input bg-muted text-[14px] text-[#6b6f66]"
                    >
                      −
                    </button>
                    <div className="w-[22px] text-center font-mono text-[13px]">{l.qty}</div>
                    <button
                      type="button"
                      onClick={() => changeQty(l.productId, 1)}
                      className="h-6 w-6 rounded-[6px] border border-input bg-muted text-[14px] text-[#6b6f66]"
                    >
                      +
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleGift(l.productId)}
                    title={l.isGift ? "Remove gift" : "Mark as gift"}
                    className="flex h-6 w-6 flex-none items-center justify-center rounded-[6px] border text-[13px]"
                    style={
                      l.isGift
                        ? { background: "var(--primary)", borderColor: "var(--primary)", color: "#fff" }
                        : { background: "var(--card)", borderColor: "var(--border)", color: "#8a8e83" }
                    }
                  >
                    🎁
                  </button>
                  <div
                    className={
                      "w-[52px] text-right font-mono text-[13px] font-semibold" +
                      (l.isGift ? " text-[#9a9e93] line-through" : "")
                    }
                  >
                    {l.lineTotal}
                  </div>
                </div>
                {l.isGift && (
                  <div className="mt-1.5">
                    <label htmlFor={`giftReason-${l.productId}`} className="sr-only">
                      Gift reason
                    </label>
                    <input
                      id={`giftReason-${l.productId}`}
                      value={l.giftReason}
                      onChange={(e) => setGiftReason(l.productId, e.target.value)}
                      placeholder="Reason (optional)"
                      className="w-full rounded-[6px] border border-input px-2 py-1 text-[11.5px]"
                    />
                  </div>
                )}
              </div>
            ))
```

- [ ] **Step 6: Add the gift-count summary line to the cart footer**

Insert this right after the existing "Items" row and before the "Total tokens" row:

```tsx
          <div className="mb-1.5 flex justify-between text-[12.5px] text-[#6b6f66]">
            <span>Items</span>
            <span className="font-mono">{cartCount}</span>
          </div>
          {giftCount > 0 && (
            <div className="mb-1.5 flex justify-between text-[12.5px] text-primary">
              <span>Includes {giftCount} gift{giftCount > 1 ? "s" : ""}</span>
            </div>
          )}
          <div className="mb-1.5 flex items-center justify-between">
            <span className="font-semibold">Total tokens</span>
            <span className="font-mono text-xl font-semibold text-primary">{cartTotal}</span>
          </div>
```

- [ ] **Step 7: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 8: Build**

Run: `node_modules/.bin/next build`
Expected: clean build, no route regressions.

- [ ] **Step 9: Manual smoke test**

Using the demo club (`admin@gaafd.test` / `SmokeTest2026!`, slug `demo`):
- Add a product to the cart, confirm it checks out normally (unchanged behavior) as a control.
- Add a product to the cart, tap the 🎁 toggle — confirm the price shows struck through, a reason input appears, and the cart's "Total tokens" figure doesn't include this line.
- Type a reason, confirm it's retained.
- Add a second, non-gifted product to the same cart — confirm "Total tokens" only reflects the paid item, and the footer shows "Includes 1 gift".
- Confirm the member's token balance before/after checkout only dropped by the paid amount.
- Cross-check the database: the new `dispense_orders` row's `items` should show `isGift: true` with the reason on the gifted line, `isGift: false` on the paid line, and `token_total` matching only the paid line.
- Toggle a gift line off before checkout — confirm it reverts to a normal priced line and the reason input disappears.

- [ ] **Step 10: Commit**

```bash
git add "src/app/[clubSlug]/dispense/dispensing-panel.tsx"
git commit -m "Add gift toggle to Dispensing cart"
```
