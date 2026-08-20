# Category-Pooled Bulk Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Products sharing a category pool their cart quantities together for the purpose of picking a bulk-pricing tier, so buying 10+10 of two same-category products unlocks the 20-tier for both, instead of each pricing independently at the 10-tier.

**Architecture:** `create_dispense_order` (7th live modification to this function) is restructured from one pricing loop into a resolve pass (look up each line's product, run existing checks, carry `category_id` forward) + a pool step (sum quantity per category) + a price pass (each line prices via its own tiers, keyed by its category's pooled quantity instead of its own qty). The client cart preview in Dispensing computes the same pooled quantity so what staff see always matches what gets charged.

**Tech Stack:** Next.js App Router, TypeScript, Supabase JS client, PL/pgSQL, Vitest.

## Global Constraints

- `security invoker` must be preserved on `create_dispense_order` (never `security definer`).
- No schema changes — `products.category_id`, `products.price_tiers`, `products.flags` all already exist and are `NOT NULL`.
- No PostgREST relation embedding anywhere.
- Stock checks and `inventory_moves` writes are unaffected by this change — they key off each line's own quantity, never the pooled quantity. Only the *price* lookup changes.
- Each product still charges its own price at whatever tier the pooled quantity unlocks — products in a category are never required to share identical tier schedules.
- Gifted quantity counts toward the pooled total (confirmed design choice) — a gift line still goes through the normal price computation (its `tokenPrice` in the snapshot reflects the pooled-tier price), only its charge is zeroed, exactly as today.
- Client and server pricing logic must never diverge — this is an established project rule since Bulk Pricing shipped.
- Migration naming: `YYYYMMDDHHMMSS_description.sql` under `supabase/migrations/`, applied via `supabase db push --linked` against the live linked project (ref `inlseklfbptgjketdnpe`) — Cottonmouth is an active trial customer using Dispensing regularly.
- pnpm exclusively, Node via `.nvmrc` (`export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use` before any command — fall back to `node_modules/.bin/*` binaries directly if the pnpm/corepack shim breaks in a given shell).
- Work directly on branch `master` (standing consent).

---

### Task 1: Migration — restructure `create_dispense_order` for category-pooled pricing

**Files:**
- Create: `supabase/migrations/20260820160000_category_pooled_pricing.sql`

**Interfaces:**
- Produces: `create_dispense_order(p_club_id uuid, p_member_id uuid, p_items jsonb, p_staff_email text default null) returns dispense_orders` — **same signature as today** (no arity/type change, so this is a true in-place `create or replace`, no overload risk this time). Behavior change only: the price used for each line is now looked up using its category's pooled quantity.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260820160000_category_pooled_pricing.sql`:

```sql
create or replace function create_dispense_order(
  p_club_id uuid,
  p_member_id uuid,
  p_items jsonb,
  p_staff_email text default null
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
  v_category_id uuid;
  v_stock integer;
  v_token_total integer := 0;
  v_snapshot jsonb := '[]'::jsonb;
  v_member_balance integer;
  v_staff_id uuid;
  v_items_agg jsonb;
  v_items_resolved jsonb := '[]'::jsonb;
  v_pooled_qty_by_category jsonb;
  v_price_tiers jsonb;
  v_is_gift boolean;
  v_gift_reason text;
  v_line_charge integer;
  v_pooled_qty integer;
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

  -- Resolve pass: look up each line's product, run the existence/gift-flag/
  -- stock checks (unchanged from before), and carry category_id forward so
  -- the price pass below can pool quantity by category.
  for v_item in select * from jsonb_array_elements(v_items_agg)
  loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'qty')::integer;
    v_is_gift := coalesce((v_item->>'is_gift')::boolean, false);
    v_gift_reason := v_item->>'gift_reason';

    select p.name, p.unit, p.token_price, p.price_tiers, p.flags, p.category_id
    into v_product_name, v_unit, v_token_price, v_price_tiers, v_flags, v_category_id
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

    v_items_resolved := v_items_resolved || jsonb_build_object(
      'product_id', v_product_id,
      'qty', v_qty,
      'is_gift', v_is_gift,
      'gift_reason', v_gift_reason,
      'name', v_product_name,
      'unit', v_unit,
      'token_price', v_token_price,
      'price_tiers', v_price_tiers,
      'category_id', v_category_id
    );
  end loop;

  -- Pool step: total quantity per category across the whole order. Gift
  -- lines are included -- volume moved is volume moved regardless of who's
  -- charged for it.
  select jsonb_object_agg(category_id::text, total_qty)
  into v_pooled_qty_by_category
  from (
    select (r->>'category_id')::uuid as category_id, sum((r->>'qty')::integer) as total_qty
    from jsonb_array_elements(v_items_resolved) as r
    group by (r->>'category_id')::uuid
  ) pooled;

  -- Price pass: each line still prices against ITS OWN tier list, but keyed
  -- by the pooled category quantity rather than the line's own individual
  -- qty. Products in a category never need matching tier schedules.
  for v_item in select * from jsonb_array_elements(v_items_resolved)
  loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'qty')::integer;
    v_is_gift := (v_item->>'is_gift')::boolean;
    v_gift_reason := v_item->>'gift_reason';
    v_product_name := v_item->>'name';
    v_unit := v_item->>'unit';
    v_token_price := (v_item->>'token_price')::integer;
    v_price_tiers := v_item->'price_tiers';
    v_category_id := (v_item->>'category_id')::uuid;

    v_pooled_qty := coalesce((v_pooled_qty_by_category ->> (v_category_id::text))::integer, v_qty);

    v_token_price := effective_unit_price(v_token_price, v_price_tiers, v_pooled_qty);

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

- [ ] **Step 2: Apply the migration**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use && supabase db push --linked`
Expected: applies cleanly.

- [ ] **Step 3: Verify nothing is left pending, and it's a true replace (not an overload)**

Run: `supabase db push --linked --dry-run`
Expected: no pending migrations listed.

```sql
select proname, pronargs, prosecdef from pg_proc where proname = 'create_dispense_order';
```
Expected: exactly one row, `pronargs = 4`, `prosecdef = false`.

- [ ] **Step 4: Scoped manual smoke test — the reported bug, reproduced and fixed**

Using the service-role admin client, create a throwaway club with one `product_categories` row ("Premium Flower") and two products in it — `London Fog Premium` and `Shortbread Premium` — both `token_price` 150 (matching the report), both `price_tiers` `[{"minQty":10,"unitPrice":100},{"minQty":20,"unitPrice":90}]`, both stock 50. Seed one member with `token_balance` 5000.

Sign in as the club's admin (the function is `security invoker`).

Call `create_dispense_order` with both products at qty 10 each (`p_items = [{"product_id":"<london-fog>","qty":10},{"product_id":"<shortbread>","qty":10}]`). Confirm:
- `token_total` is exactly **1800** (not 2000).
- Both snapshot items show `tokenPrice: 90`.
- Neither product's stock/inventory is affected beyond the expected -10 each.

Then call it again with each product at qty 10 in **separate** single-item orders (simulating the pre-pooling case) and confirm each individually prices at `tokenPrice: 100` (10-tier), `lineTotal: 1000` — i.e. pooling only kicks in when both are in the *same* order.

Delete the throwaway club afterward (cascades).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260820160000_category_pooled_pricing.sql
git commit -m "Pool quantities by category when picking a bulk-pricing tier"
```

---

### Task 2: Automated tests for category-pooled pricing

**Files:**
- Modify: `tests/dispensing.test.ts`

**Interfaces:**
- Consumes: Task 1's migration. No `src/` changes needed for this task — `createDispenseOrder` (`src/lib/dispensing.ts`) already forwards `items` unchanged; pooling is entirely server-side, so the existing TS wrapper needs no modification to exercise it.

- [ ] **Step 1: Extend `seedProduct` with an optional `priceTiers` parameter**

Every pooling test needs specific tier schedules, so `seedProduct` (used throughout this file) gets a 5th optional parameter defaulting to `[]` — every existing call site (which never passes it) keeps compiling and behaving identically:

Change:

```ts
async function seedProduct(clubId: string, tokenPrice: number, stock: number, flags: string[] = []) {
```

to:

```ts
async function seedProduct(
  clubId: string,
  tokenPrice: number,
  stock: number,
  flags: string[] = [],
  priceTiers: { minQty: number; unitPrice: number }[] = [],
) {
```

and in the `.insert({...})` call inside it, add `price_tiers: priceTiers,` alongside the existing `flags,` field:

```ts
    .insert({
      club_id: clubId,
      name: `Dispense Test Product ${crypto.randomUUID().slice(0, 8)}`,
      category_id: category.id,
      unit: "per 1g",
      token_price: tokenPrice,
      sell_price: tokenPrice * 1.5,
      flags,
      price_tiers: priceTiers,
    })
```

- [ ] **Step 2: Add a new `describe("category-pooled bulk pricing")` block with 5 tests**

Add at the end of the file (after the existing top-level `describe` blocks), using the file's existing `data`, `clubAClient`, `seedProduct`, `seedMemberWithBalance`, `getStock`, `getBalance`, `cleanupOrderIds`, and `createAdminClient` — all already defined earlier in this file:

```ts
describe("category-pooled bulk pricing", () => {
  const TIERS = [
    { minQty: 10, unitPrice: 100 },
    { minQty: 20, unitPrice: 90 },
  ];

  it("prices a single product against its own quantity when nothing else pools with it (regression)", async () => {
    const product = await seedProduct(data.clubA.clubId, 150, 50, [], TIERS);
    const member = await seedMemberWithBalance(data.clubA.clubId, 5000);

    const order = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: product.id, qty: 10 },
    ]);
    cleanupOrderIds.push(order.id);

    expect(order.items[0].tokenPrice).toBe(100);
    expect(order.items[0].lineTotal).toBe(1000);
    expect(order.tokenTotal).toBe(1000);
  });

  it("pools quantities across two products in the same category to unlock a shared tier", async () => {
    const productA = await seedProduct(data.clubA.clubId, 150, 50, [], TIERS);
    const productB = await seedProduct(data.clubA.clubId, 150, 50, [], TIERS);
    const member = await seedMemberWithBalance(data.clubA.clubId, 5000);

    const order = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: productA.id, qty: 10 },
      { productId: productB.id, qty: 10 },
    ]);
    cleanupOrderIds.push(order.id);

    expect(order.tokenTotal).toBe(1800);
    for (const item of order.items) {
      expect(item.tokenPrice).toBe(90);
      expect(item.lineTotal).toBe(900);
    }
  });

  it("does not pool quantities across different categories", async () => {
    const admin = createAdminClient();
    const productA = await seedProduct(data.clubA.clubId, 150, 50, [], TIERS);

    const { data: secondCategory, error: categoryError } = await admin
      .from("product_categories")
      .insert({ club_id: data.clubA.clubId, name: `Other Category ${crypto.randomUUID().slice(0, 8)}` })
      .select()
      .single();
    if (categoryError) throw categoryError;

    const { data: productB, error: productError } = await admin
      .from("products")
      .insert({
        club_id: data.clubA.clubId,
        name: `Dispense Test Product ${crypto.randomUUID().slice(0, 8)}`,
        category_id: secondCategory.id,
        unit: "per 1g",
        token_price: 150,
        sell_price: 225,
        flags: [],
        price_tiers: TIERS,
      })
      .select()
      .single();
    if (productError) throw productError;

    const { data: move, error: moveError } = await admin
      .from("inventory_moves")
      .insert({ club_id: data.clubA.clubId, product_id: productB.id, type: "PURCHASE", qty: 50 })
      .select()
      .single();
    if (moveError) throw moveError;

    const member = await seedMemberWithBalance(data.clubA.clubId, 5000);

    const order = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: productA.id, qty: 10 },
      { productId: productB.id, qty: 10 },
    ]);
    cleanupOrderIds.push(order.id);

    expect(order.tokenTotal).toBe(2000);
    for (const item of order.items) {
      expect(item.tokenPrice).toBe(100);
    }

    await admin.from("inventory_moves").delete().eq("id", move.id);
    await admin.from("products").delete().eq("id", productB.id);
    await admin.from("product_categories").delete().eq("id", secondCategory.id);
  });

  it("each product keeps its own tier price when pooled quantity is evaluated against different tier schedules", async () => {
    const productA = await seedProduct(data.clubA.clubId, 150, 50, [], TIERS);
    const productB = await seedProduct(data.clubA.clubId, 150, 50, [], [{ minQty: 15, unitPrice: 95 }]);
    const member = await seedMemberWithBalance(data.clubA.clubId, 5000);

    const order = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: productA.id, qty: 10 },
      { productId: productB.id, qty: 10 },
    ]);
    cleanupOrderIds.push(order.id);

    const itemA = order.items.find((i) => i.productId === productA.id)!;
    const itemB = order.items.find((i) => i.productId === productB.id)!;

    expect(itemA.tokenPrice).toBe(90);
    expect(itemB.tokenPrice).toBe(95);
    expect(order.tokenTotal).toBe(900 + 950);
  });

  it("gifted quantity counts toward the pooled total that unlocks a paid line's tier", async () => {
    const giftProduct = await seedProduct(data.clubA.clubId, 150, 50, ["gift"], TIERS);
    const paidProduct = await seedProduct(data.clubA.clubId, 150, 50, [], TIERS);
    const member = await seedMemberWithBalance(data.clubA.clubId, 5000);

    const order = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: giftProduct.id, qty: 10, isGift: true },
      { productId: paidProduct.id, qty: 10 },
    ]);
    cleanupOrderIds.push(order.id);

    const giftItem = order.items.find((i) => i.productId === giftProduct.id)!;
    const paidItem = order.items.find((i) => i.productId === paidProduct.id)!;

    expect(giftItem.tokenPrice).toBe(90);
    expect(giftItem.lineTotal).toBe(900);
    expect(paidItem.tokenPrice).toBe(90);
    expect(order.tokenTotal).toBe(900);

    expect(await getStock(giftProduct.id)).toBe(40);
    expect(await getStock(paidProduct.id)).toBe(40);
  });
});
```

- [ ] **Step 3: Run the affected test file**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use && node_modules/.bin/vitest run tests/dispensing.test.ts`
Expected: all tests pass, including the 5 new ones and every pre-existing test in this file (confirming `flags`-default and now `priceTiers`-default changes are fully backward compatible).

- [ ] **Step 4: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add tests/dispensing.test.ts
git commit -m "Add tests for category-pooled bulk pricing"
```

---

### Task 3: Client — pool quantities in the Dispensing cart preview

**Files:**
- Modify: `src/app/[clubSlug]/dispense/dispensing-panel.tsx`

**Interfaces:**
- Consumes: `Product.categoryId` (`src/lib/products.ts`, already exists), `effectiveUnitPrice(basePrice, tiers, qty)` (already exists, signature unchanged).

- [ ] **Step 1: Add a `pooledQtyByCategory` map and use it in `cartLines`**

The current `cartLines` derivation (in `src/app/[clubSlug]/dispense/dispensing-panel.tsx`) is:

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
      isGiftable: product?.flags.includes("gift") ?? false,
      giftReason: giftLines[productId] ?? "",
      chargedTotal: isGift ? 0 : lineTotal,
    };
  });
```

Add a `pooledQtyByCategory` computation immediately before it, and change the `tokenPrice` line to use the pooled quantity for that product's category instead of the line's own `qty`:

```ts
  const pooledQtyByCategory = new Map<string, number>();
  for (const [productId, qty] of Object.entries(cart)) {
    const product = productById.get(productId);
    if (!product) continue;
    pooledQtyByCategory.set(
      product.categoryId,
      (pooledQtyByCategory.get(product.categoryId) ?? 0) + qty,
    );
  }

  const cartLines = Object.entries(cart).map(([productId, qty]) => {
    const product = productById.get(productId);
    const pooledQty = product ? (pooledQtyByCategory.get(product.categoryId) ?? qty) : qty;
    const tokenPrice = product ? effectiveUnitPrice(product.tokenPrice, product.priceTiers, pooledQty) : 0;
    const isGift = productId in giftLines;
    const lineTotal = tokenPrice * qty;
    return {
      productId,
      qty,
      name: product?.name ?? "—",
      tokenPrice,
      lineTotal,
      isGift,
      isGiftable: product?.flags.includes("gift") ?? false,
      giftReason: giftLines[productId] ?? "",
      chargedTotal: isGift ? 0 : lineTotal,
    };
  });
```

`pooledQtyByCategory` is recomputed on every render from `cart` — this file has no `useMemo` around `cartLines` today (it's plain derivation on every render already), so no new memoization concern is introduced; this stays consistent with the file's existing style.

- [ ] **Step 2: Typecheck**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use && node_modules/.bin/tsc --noEmit`
Expected: no output, exit 0 — project-wide clean.

- [ ] **Step 3: Build**

Run: `node_modules/.bin/next build`
Expected: clean build, no regressions.

- [ ] **Step 4: Manual smoke test reproducing the exact reported scenario**

Using the demo club (`admin@gaafd.test` / `SmokeTest2026!`, slug `demo`) or Cottonmouth (`Rnp2602@gmail.com`): on Products, create (or reuse) two products in the same category, both with tiers `10 @ 100` / `20 @ 90` (or confirm two existing same-category products already have matching tiers). In Dispensing, add 10 of the first and 10 of the second to the cart. Confirm the cart preview shows each line priced at 90/unit (not 100), and the total reads **1800**, not 2000 — matching Task 1's server-side smoke test exactly. Then remove one product entirely (down to just 10 of the other) and confirm it reprices back to 100/unit — pooling only applies while both are present.

- [ ] **Step 5: Commit**

```bash
git add "src/app/[clubSlug]/dispense/dispensing-panel.tsx"
git commit -m "Pool cart quantities by category in the Dispensing price preview"
```
