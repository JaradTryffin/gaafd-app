# Bulk / Quantity-Based Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin configure per-product quantity price breaks (e.g. 1g = R150, 10g+ = R100/g) that automatically apply during Dispensing checkout, without disrupting any of Cottonmouth's existing live product data.

**Architecture:** One additive column (`products.price_tiers jsonb`), one new pure SQL helper (`effective_unit_price`) plus a single targeted change to the already-shipped `create_dispense_order` function, a data-layer extension (`src/lib/products.ts`), and UI additions to the existing Products modal and Dispensing screen. Split into 4 tasks matching the original Dispensing feature's shape — schema and the checkout-function change each get their own dedicated review gate, since this modifies a live, real-money-adjacent function a real customer already depends on.

**Tech Stack:** Next.js App Router, TypeScript, Supabase JS client, PL/pgSQL, Vitest.

## Global Constraints

- Reuse `src/lib/supabase/server.ts`, `src/lib/auth/require-role.ts`'s `assertClubAdmin`, `src/lib/toast-context.tsx`'s `useToast` exactly as they exist — do not modify any of them. Do not modify `src/lib/dispensing.ts` or the RPC's parameter/return shape.
- No PostgREST relation embedding anywhere.
- No shadcn/`@base-ui/react` components — hand-rolled Tailwind, matching every prior screen.
- Every labeled form field needs `htmlFor`/`id` pairing.
- Migration files follow the existing `YYYYMMDDHHMMSS_description.sql` naming, applied via `supabase db push --linked` against the live linked project (ref `inlseklfbptgjketdnpe`) — **this project has real customer data (Cottonmouth) in it now.** Every migration in this plan must be verified with `--dry-run` first, and Task 1's column-add must be confirmed additive/non-destructive before applying.
- pnpm exclusively, Node via `.nvmrc` (run `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use` before any command — fall back to `node_modules/.bin/tsc`/`node_modules/.bin/next`/`node_modules/.bin/vitest` directly if this environment's pnpm/corepack shim still breaks).
- Commit messages plain, imperative. Work on branch `master` directly (standing consent from all prior phases).
- `Product`/`ProductInput`/`ProductRow` (`src/lib/products.ts`) and `DispenseOrder`/`DispenseOrderItem`/`CartItem` (`src/lib/dispensing.ts`) types used in this plan are confirmed against the actual current files — no drift.

---

### Task 1: Migration — `products.price_tiers` column

**Files:**
- Create: `supabase/migrations/20260811160000_bulk_pricing_schema.sql`

**Interfaces:**
- Produces: `products.price_tiers` (`jsonb not null default '[]'::jsonb`) — consumed by Task 2's SQL functions and Task 3's data layer.

No application code in this task — pure schema, verified against the live project directly. This is the task that touches Cottonmouth's real, already-populated `products` rows.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260811160000_bulk_pricing_schema.sql`:

```sql
alter table products add column price_tiers jsonb not null default '[]'::jsonb;
```

- [ ] **Step 2: Apply the migration**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use && supabase db push --linked`
Expected: lists the new migration, applies it, ends with `Finished supabase db push.`

- [ ] **Step 3: Verify nothing is left pending**

Run: `supabase db push --linked --dry-run`
Expected: no pending migrations listed.

- [ ] **Step 4: Verify the column exists and every existing row (including Cottonmouth's real products) got the default**

```sql
select column_name, data_type, is_nullable, column_default from information_schema.columns
where table_name = 'products' and column_name = 'price_tiers';
```
Expected: one row, `data_type = jsonb`, `is_nullable = NO`, `column_default` mentions `'[]'::jsonb`.

```sql
select count(*) as total, count(*) filter (where price_tiers = '[]'::jsonb) as empty_tiers from products;
```
Expected: `total` equals `empty_tiers` — every single existing product row (Cottonmouth's included) has the default empty array, none were altered or lost. This is the non-destructive confirmation the plan's global constraints require.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260811160000_bulk_pricing_schema.sql
git commit -m "Add price_tiers column to products for bulk pricing"
```

---

### Task 2: Migration — `effective_unit_price` helper + `create_dispense_order` update

**Files:**
- Create: `supabase/migrations/20260811160100_bulk_pricing_functions.sql`

**Interfaces:**
- Consumes: Task 1's `products.price_tiers` column.
- Produces: `effective_unit_price(p_base_price integer, p_tiers jsonb, p_qty integer) returns integer` — a new standalone helper. Updates `create_dispense_order` in place (same signature, same `returns dispense_orders`) — no interface change for Task 3's `src/lib/dispensing.ts` caller, which is untouched.

This is the highest-risk task in this plan — it modifies a live, already-shipped, real-money-adjacent function for the second time in this project's history (the first was the duplicate-product-lines fix). Make exactly the one change described below and nothing else.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260811160100_bulk_pricing_functions.sql`. First, the new helper:

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

Then `create_dispense_order`, which is the CURRENT live version (from `supabase/migrations/20260801120000_fix_dispense_order_duplicate_products.sql`) with exactly two changes: (a) `v_price_tiers jsonb;` added to the `declare` block, (b) the product lookup now also selects `p.price_tiers`, and (c) one new line calling `effective_unit_price` is inserted after the stock-sufficiency check and before the token-total accumulation. Nothing else in this function changes — not the aggregation logic, not the atomicity, not the defense-in-depth checks, not the two loops' structure:

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

  select jsonb_agg(jsonb_build_object('product_id', product_id, 'qty', qty))
  into v_items_agg
  from (
    select (item->>'product_id')::uuid as product_id, sum((item->>'qty')::integer) as qty
    from jsonb_array_elements(p_items) as item
    group by (item->>'product_id')::uuid
  ) agg;

  for v_item in select * from jsonb_array_elements(v_items_agg)
  loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'qty')::integer;

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

    v_token_total := v_token_total + (v_token_price * v_qty);
    v_snapshot := v_snapshot || jsonb_build_object(
      'productId', v_product_id,
      'productName', v_product_name,
      'unit', v_unit,
      'qty', v_qty,
      'tokenPrice', v_token_price,
      'lineTotal', v_token_price * v_qty
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

Run: `supabase db push --linked`
Expected: applies cleanly.

- [ ] **Step 3: Verify nothing is left pending**

Run: `supabase db push --linked --dry-run`
Expected: no pending migrations listed.

- [ ] **Step 4: Verify both functions exist and `create_dispense_order` is still `security invoker`**

```sql
select proname, prosecdef from pg_proc where proname in ('effective_unit_price', 'create_dispense_order');
```
Expected: two rows. `create_dispense_order` has `prosecdef = false` (still invoker — this migration must not accidentally change that). `effective_unit_price` has no meaningful `prosecdef` implication (it's a plain SQL function touching no tables), but confirm it exists.

- [ ] **Step 5: Scoped manual E2E smoke test of `effective_unit_price` in isolation**

Before testing the full checkout flow (Task 3's automated suite covers that exhaustively), sanity-check the helper directly:

```sql
select effective_unit_price(150, '[]'::jsonb, 5);
```
Expected: `150` (no tiers, always base price).

```sql
select effective_unit_price(150, '[{"minQty":10,"unitPrice":100}]'::jsonb, 5);
```
Expected: `150` (qty below the tier's `minQty`).

```sql
select effective_unit_price(150, '[{"minQty":10,"unitPrice":100}]'::jsonb, 10);
```
Expected: `100` (qty at the threshold).

```sql
select effective_unit_price(150, '[{"minQty":10,"unitPrice":100},{"minQty":20,"unitPrice":90}]'::jsonb, 25);
```
Expected: `90` (qty past BOTH thresholds — picks the highest-`minQty` qualifying tier, not the first).

- [ ] **Step 6: Scoped manual E2E smoke test of the full checkout with a tier applied**

Using the service-role admin client, create a throwaway club with 1 product (stock 50, `token_price` 150, `price_tiers: [{"minQty": 10, "unitPrice": 100}]` set directly on insert) and 1 member (`token_balance` 5000) — mirror `tests/rls/fixtures.ts`'s `seedClub` approach, not the shared fixture function itself.

(a) Call `create_dispense_order` with a single-line item `{product_id, qty: 5}` (below the tier). Confirm `token_total = 750` (5 × 150, base price) and `items[0].tokenPrice = 150`.

(b) Call it again with `{product_id, qty: 10}` (at the tier). Confirm `token_total = 1000` (10 × 100, tier price) and `items[0].tokenPrice = 100`.

Delete the throwaway club afterward (cascades).

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260811160100_bulk_pricing_functions.sql
git commit -m "Add effective_unit_price helper and apply tiered pricing in create_dispense_order"
```

---

### Task 3: Data layer + tests

**Files:**
- Modify: `src/lib/products.ts`
- Test: `tests/products.test.ts`
- Test: `tests/dispensing.test.ts`

**Interfaces:**
- Consumes: Task 1/2's schema and functions.
- Produces: `PriceTier` type, `Product.priceTiers`/`ProductInput.priceTiers`, `effectiveUnitPrice(basePrice: number, tiers: PriceTier[], qty: number): number` — all consumed by Task 4's UI.

- [ ] **Step 1: Add the `PriceTier` type and extend `Product`/`ProductRow`/`ProductInput` in `src/lib/products.ts`**

Add near the top of the file, before `export type Product`:

```ts
export type PriceTier = { minQty: number; unitPrice: number };
```

Add `priceTiers: PriceTier[];` as a new field to the existing `Product` type (after `stock: number;`):

```ts
export type Product = {
  id: string;
  name: string;
  category: ProductCategory;
  unit: string;
  tokenPrice: number;
  sellPrice: number;
  cost: number | null;
  description: string | null;
  flags: string[];
  active: boolean;
  stock: number;
  priceTiers: PriceTier[];
};
```

Add `price_tiers: PriceTier[];` to `ProductRow` (after `flags: string[];`):

```ts
type ProductRow = {
  id: string;
  name: string;
  category: string;
  unit: string;
  token_price: number;
  sell_price: number;
  cost: number | null;
  description: string | null;
  flags: string[];
  price_tiers: PriceTier[];
  active: boolean;
};
```

Add `priceTiers: row.price_tiers ?? [],` inside `mapProduct` (after `flags: row.flags ?? [],`):

```ts
function mapProduct(row: ProductRow, stock: number): Product {
  return {
    id: row.id,
    name: row.name,
    category: row.category as ProductCategory,
    unit: row.unit,
    tokenPrice: row.token_price,
    sellPrice: Number(row.sell_price),
    cost: row.cost === null ? null : Number(row.cost),
    description: row.description,
    flags: row.flags ?? [],
    priceTiers: row.price_tiers ?? [],
    active: row.active,
    stock,
  };
}
```

Update `PRODUCT_COLUMNS` to include the new column:

```ts
const PRODUCT_COLUMNS = "id, name, category, unit, token_price, sell_price, cost, description, flags, price_tiers, active";
```

Add `priceTiers: PriceTier[];` to `ProductInput` (after `flags: string[];`):

```ts
export type ProductInput = {
  name: string;
  category: ProductCategory;
  unit: string;
  tokenPrice: number;
  sellPrice: number;
  cost?: number | null;
  description?: string | null;
  flags: string[];
  priceTiers: PriceTier[];
};
```

- [ ] **Step 2: Write `price_tiers` in `createProduct` and `updateProduct`**

In `createProduct`, add `price_tiers: input.priceTiers,` to the insert payload (after `flags: input.flags,`):

```ts
export async function createProduct(
  supabase: SupabaseClient,
  clubId: string,
  input: ProductInput,
): Promise<Product> {
  await assertClubAdmin(supabase, clubId);
  const { data, error } = await supabase
    .from("products")
    .insert({
      club_id: clubId,
      name: input.name,
      category: input.category,
      unit: input.unit,
      token_price: input.tokenPrice,
      sell_price: input.sellPrice,
      cost: input.cost ?? null,
      description: input.description || null,
      flags: input.flags,
      price_tiers: input.priceTiers,
    })
    .select(PRODUCT_COLUMNS)
    .single();
  if (error) throw error;
  return mapProduct(data as ProductRow, 0);
}
```

In `updateProduct`, add `price_tiers: input.priceTiers,` to the update payload (after `flags: input.flags,`):

```ts
export async function updateProduct(
  supabase: SupabaseClient,
  clubId: string,
  productId: string,
  input: ProductInput,
): Promise<Product> {
  await assertClubAdmin(supabase, clubId);
  const { data, error } = await supabase
    .from("products")
    .update({
      name: input.name,
      category: input.category,
      unit: input.unit,
      token_price: input.tokenPrice,
      sell_price: input.sellPrice,
      cost: input.cost ?? null,
      description: input.description || null,
      flags: input.flags,
      price_tiers: input.priceTiers,
    })
    .eq("id", productId)
    .eq("club_id", clubId)
    .select(PRODUCT_COLUMNS)
    .single();
  if (error) throw error;
```

(The rest of `updateProduct`'s body, the `product_stock` read and `mapProduct` call, is unchanged.)

- [ ] **Step 3: Add `effectiveUnitPrice` to `src/lib/products.ts`**

Add at the end of the file:

```ts
export function effectiveUnitPrice(basePrice: number, tiers: PriceTier[], qty: number): number {
  const applicable = tiers.filter((t) => t.minQty <= qty).sort((a, b) => b.minQty - a.minQty);
  return applicable.length > 0 ? applicable[0].unitPrice : basePrice;
}
```

- [ ] **Step 4: Add round-trip tests to `tests/products.test.ts`**

Add a new `describe` block:

```ts
describe("price tiers", () => {
  it("round-trips priceTiers through createProduct and updateProduct", async () => {
    const created = await createProduct(clubAClient, data.clubA.clubId, {
      name: "Tiered Product",
      category: "Flower",
      unit: "per 1g",
      tokenPrice: 150,
      sellPrice: 225,
      flags: [],
      priceTiers: [{ minQty: 10, unitPrice: 100 }],
    });
    cleanupProductIds.push(created.id);
    expect(created.priceTiers).toEqual([{ minQty: 10, unitPrice: 100 }]);

    const withoutTiers = await createProduct(clubAClient, data.clubA.clubId, {
      name: "Untiered Product",
      category: "Flower",
      unit: "per 1g",
      tokenPrice: 40,
      sellPrice: 60,
      flags: [],
      priceTiers: [],
    });
    cleanupProductIds.push(withoutTiers.id);
    expect(withoutTiers.priceTiers).toEqual([]);

    const updated = await updateProduct(clubAClient, data.clubA.clubId, created.id, {
      name: "Tiered Product",
      category: "Flower",
      unit: "per 1g",
      tokenPrice: 150,
      sellPrice: 225,
      flags: [],
      priceTiers: [
        { minQty: 10, unitPrice: 100 },
        { minQty: 20, unitPrice: 90 },
      ],
    });
    expect(updated.priceTiers).toEqual([
      { minQty: 10, unitPrice: 100 },
      { minQty: 20, unitPrice: 90 },
    ]);
  });
});
```

- [ ] **Step 5: Add bulk-pricing checkout tests to `tests/dispensing.test.ts`**

Add a new `describe` block (reuses this file's existing `seedProduct`/`seedMemberWithBalance` helpers and `createAdminClient`, `cleanupOrderIds` arrays exactly as they already exist in the file):

```ts
describe("bulk pricing", () => {
  it("checks out at the flat price when no tiers are configured (regression)", async () => {
    const product = await seedProduct(data.clubA.clubId, 150, 50);
    const member = await seedMemberWithBalance(data.clubA.clubId, 5000);

    const order = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: product.id, qty: 3 },
    ]);
    cleanupOrderIds.push(order.id);

    expect(order.tokenTotal).toBe(450);
    expect(order.items[0].tokenPrice).toBe(150);
  });

  it("applies the base price below a tier threshold and the tier price at/above it", async () => {
    const product = await seedProduct(data.clubA.clubId, 150, 50);
    const member = await seedMemberWithBalance(data.clubA.clubId, 5000);
    const admin = createAdminClient();
    const { error } = await admin
      .from("products")
      .update({ price_tiers: [{ minQty: 10, unitPrice: 100 }] })
      .eq("id", product.id);
    if (error) throw error;

    const belowThreshold = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: product.id, qty: 5 },
    ]);
    cleanupOrderIds.push(belowThreshold.id);
    expect(belowThreshold.tokenTotal).toBe(750);
    expect(belowThreshold.items[0].tokenPrice).toBe(150);

    const atThreshold = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: product.id, qty: 10 },
    ]);
    cleanupOrderIds.push(atThreshold.id);
    expect(atThreshold.tokenTotal).toBe(1000);
    expect(atThreshold.items[0].tokenPrice).toBe(100);
  });

  it("prices a two-line order of the same product at the tier rate when the combined quantity crosses the threshold", async () => {
    const product = await seedProduct(data.clubA.clubId, 150, 50);
    const member = await seedMemberWithBalance(data.clubA.clubId, 5000);
    const admin = createAdminClient();
    const { error } = await admin
      .from("products")
      .update({ price_tiers: [{ minQty: 10, unitPrice: 100 }] })
      .eq("id", product.id);
    if (error) throw error;

    // Neither line alone reaches qty 10, but combined (4+6=10) they do —
    // proves the tier lookup happens after aggregation, not per raw line.
    const order = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: product.id, qty: 4 },
      { productId: product.id, qty: 6 },
    ]);
    cleanupOrderIds.push(order.id);

    expect(order.tokenTotal).toBe(1000);
    expect(order.items).toHaveLength(1);
    expect(order.items[0].qty).toBe(10);
    expect(order.items[0].tokenPrice).toBe(100);
  });
});
```

- [ ] **Step 6: Run all affected test files**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use && node_modules/.bin/vitest run tests/products.test.ts tests/dispensing.test.ts`
Expected: all tests pass, including the new `describe("price tiers", ...)` and `describe("bulk pricing", ...)` blocks.

- [ ] **Step 7: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/lib/products.ts tests/products.test.ts tests/dispensing.test.ts
git commit -m "Add price tier data layer and checkout pricing tests"
```

---

### Task 4: UI — Products bulk-pricing editor + Dispensing hint and live cart repricing

**Files:**
- Modify: `src/app/[clubSlug]/products/products-table.tsx`
- Modify: `src/app/[clubSlug]/dispense/dispensing-panel.tsx`

**Interfaces:**
- Consumes: Task 3's `PriceTier` type and `effectiveUnitPrice` function from `@/lib/products`.

- [ ] **Step 1: Extend `ProductDraft` and its helpers in `products-table.tsx`**

Add a string-based tier-draft type and extend `ProductDraft` (numeric fields are kept as strings in drafts throughout this file, matching the existing `tokenPrice`/`sellPrice`/`cost` pattern):

```ts
type PriceTierDraft = { minQty: string; unitPrice: string };

type ProductDraft = {
  name: string;
  category: ProductCategory;
  unit: string;
  tokenPrice: string;
  sellPrice: string;
  cost: string;
  description: string;
  flags: string[];
  priceTiers: PriceTierDraft[];
};
```

Add `priceTiers: [],` to `EMPTY_DRAFT`:

```ts
const EMPTY_DRAFT: ProductDraft = {
  name: "",
  category: "Flower",
  unit: "",
  tokenPrice: "",
  sellPrice: "",
  cost: "",
  description: "",
  flags: [],
  priceTiers: [],
};
```

Update `draftFromProduct` to map `product.priceTiers` to string drafts:

```ts
function draftFromProduct(product: Product): ProductDraft {
  return {
    name: product.name,
    category: product.category,
    unit: product.unit,
    tokenPrice: String(product.tokenPrice),
    sellPrice: String(product.sellPrice),
    cost: product.cost === null ? "" : String(product.cost),
    description: product.description ?? "",
    flags: product.flags,
    priceTiers: product.priceTiers.map((t) => ({
      minQty: String(t.minQty),
      unitPrice: String(t.unitPrice),
    })),
  };
}
```

- [ ] **Step 2: Add tier-row handlers**

Add these functions near `toggleFlag` (inside the `ProductsTable` component body):

```ts
  function addTierRow() {
    setDraft((prev) => ({ ...prev, priceTiers: [...prev.priceTiers, { minQty: "", unitPrice: "" }] }));
  }

  function removeTierRow(index: number) {
    setDraft((prev) => ({ ...prev, priceTiers: prev.priceTiers.filter((_, i) => i !== index) }));
  }

  function updateTierRow(index: number, field: "minQty" | "unitPrice", value: string) {
    setDraft((prev) => ({
      ...prev,
      priceTiers: prev.priceTiers.map((t, i) =>
        i === index ? { ...t, [field]: value.replace(/[^0-9]/g, "") } : t,
      ),
    }));
  }
```

- [ ] **Step 3: Include `priceTiers` in the save payload, filtering out incomplete rows**

In `handleSave`, change the `input` object construction to filter and convert tier drafts (incomplete rows — where either field is blank or zero — are silently dropped rather than saved as garbage):

```ts
    startSaving(async () => {
      const input = {
        name: draft.name,
        category: draft.category,
        unit: draft.unit,
        tokenPrice: Number(draft.tokenPrice) || 0,
        sellPrice: Number(draft.sellPrice) || 0,
        cost: draft.cost === "" ? null : Number(draft.cost),
        description: draft.description || null,
        flags: draft.flags,
        priceTiers: draft.priceTiers
          .map((t) => ({ minQty: Number(t.minQty) || 0, unitPrice: Number(t.unitPrice) || 0 }))
          .filter((t) => t.minQty > 0 && t.unitPrice > 0),
      };
```

(The rest of `handleSave` — the `createProductAction`/`updateProductAction` call and result handling — is unchanged.)

- [ ] **Step 4: Add the "Bulk pricing" section to the modal**

Insert this new section right after the closing `</div>` of the "Flags" section (which ends just before `{modalMode === "edit" && (`) and before the stock-notice block:

```tsx
              <div className="mb-4">
                <div className="mb-[7px] flex items-center justify-between">
                  <div className="text-[11px] text-[#8a8e83]">Bulk pricing</div>
                  <button
                    type="button"
                    onClick={addTierRow}
                    className="rounded-[6px] border border-input bg-muted px-2 py-1 text-[11px] font-medium text-[#6b6f66]"
                  >
                    + Add price break
                  </button>
                </div>
                {draft.priceTiers.length === 0 ? (
                  <p className="text-[11.5px] text-[#9a9e93]">
                    No bulk pricing configured — every quantity charges the token price above.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {draft.priceTiers.map((tier, index) => (
                      <div key={index} className="flex items-center gap-2">
                        <div className="flex-1">
                          <label htmlFor={`tierMinQty-${index}`} className="sr-only">
                            Minimum quantity
                          </label>
                          <input
                            id={`tierMinQty-${index}`}
                            inputMode="numeric"
                            value={tier.minQty}
                            onChange={(e) => updateTierRow(index, "minQty", e.target.value)}
                            placeholder="Qty (e.g. 10)"
                            className="w-full rounded-[8px] border border-input px-2.5 py-2 font-mono text-[12.5px]"
                          />
                        </div>
                        <span className="text-[11px] text-[#9a9e93]">at</span>
                        <div className="flex-1">
                          <label htmlFor={`tierUnitPrice-${index}`} className="sr-only">
                            Price per unit at this quantity
                          </label>
                          <input
                            id={`tierUnitPrice-${index}`}
                            inputMode="numeric"
                            value={tier.unitPrice}
                            onChange={(e) => updateTierRow(index, "unitPrice", e.target.value)}
                            placeholder="Tok/unit (e.g. 100)"
                            className="w-full rounded-[8px] border border-input px-2.5 py-2 font-mono text-[12.5px]"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => removeTierRow(index)}
                          title="Remove price break"
                          className="h-[30px] w-[30px] flex-none rounded-[7px] border border-input text-[13px] text-destructive"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
```

- [ ] **Step 5: Show a bulk-price hint on the Dispensing product card**

In `src/app/[clubSlug]/dispense/dispensing-panel.tsx`, inside the product grid's card (`filteredProducts.map((p) => ...)`), add a hint line right after the existing token-price/`+`-button row (after its closing `</div>`, still inside the `<div className="px-3 py-2.5">` wrapper):

```tsx
                {p.priceTiers.length > 0 && (
                  <div className="mt-1 truncate text-[10px] text-[#8a8e83]">
                    {[...p.priceTiers]
                      .sort((a, b) => a.minQty - b.minQty)
                      .map((t) => `${t.minQty}+: ${t.unitPrice} tok`)
                      .join(" · ")}
                  </div>
                )}
```

- [ ] **Step 6: Apply tiered pricing to the cart's live totals**

In the same file, import `effectiveUnitPrice` alongside the existing `Product`/`ProductCategory` type import:

```ts
import { effectiveUnitPrice, type Product, type ProductCategory } from "@/lib/products";
```

Change the `cartLines` computation from the flat `product?.tokenPrice ?? 0` to the tiered lookup:

```ts
  const cartLines = Object.entries(cart).map(([productId, qty]) => {
    const product = productById.get(productId);
    const tokenPrice = product ? effectiveUnitPrice(product.tokenPrice, product.priceTiers, qty) : 0;
    return {
      productId,
      qty,
      name: product?.name ?? "—",
      tokenPrice,
      lineTotal: tokenPrice * qty,
    };
  });
```

(Everything downstream of `cartLines` — `cartCount`, `cartTotal`, `balanceAfter`, `canCheckout`, the cart line JSX, the checkout call — is unchanged; they already just read `l.tokenPrice`/`l.lineTotal`, which now reflect the tiered price automatically. This is a UX preview only — the RPC re-derives the authoritative price server-side regardless, per this app's established "server re-verifies, never trusts the client" convention.)

- [ ] **Step 7: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 8: Build**

Run: `node_modules/.bin/next build`
Expected: clean build, no route regressions.

- [ ] **Step 9: Manual smoke test**

Using the demo club (`admin@gaafd.test` / `SmokeTest2026!`, slug `demo`):
- Create or edit a product, add a price break (e.g. min qty 10, price 100, with the product's base token price at 150). Confirm the row appears, can be removed, and saving persists it (reopen the edit modal, confirm the tier is still there).
- Go to Dispensing. Confirm that product's card shows the bulk-price hint under its normal price.
- Add fewer than the threshold quantity to the cart (e.g. 5) — confirm the line total uses the base price.
- Increase the quantity past the threshold (e.g. to 10) via the +/- controls — confirm the line's unit price and total switch to the discounted rate live, without needing to complete checkout first.
- Complete the checkout and confirm the toast/resulting order matches the discounted total (cross-check against the database if convenient — `dispense_orders.items[0].tokenPrice` should equal the tier price).
- Confirm a product with NO tiers configured still shows and behaves exactly as before (no hint line, flat pricing).

- [ ] **Step 10: Commit**

```bash
git add "src/app/[clubSlug]/products/products-table.tsx" "src/app/[clubSlug]/dispense/dispensing-panel.tsx"
git commit -m "Add bulk pricing editor to Products and live tiered pricing in Dispensing"
```
