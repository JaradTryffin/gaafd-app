# Gift Visibility & Flag Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the "Gifting allowed" product flag so it stops implying a control that doesn't exist, and give the owner an admin-only Order History screen to actually see checkouts — including gifts — without raw SQL.

**Architecture:** One additive column + the 5th modification to `create_dispense_order` (its own dedicated review gate, same discipline as every prior change to this function), then the data layer + a critical shared-fixture fix + tests, then the UI (a gated toggle in Dispensing, a brand-new admin-only screen, a sidebar entry).

**Tech Stack:** Next.js App Router, TypeScript, Supabase JS client (`.rpc()`), PL/pgSQL, Vitest.

## Global Constraints

- Reuse `src/lib/supabase/server.ts`, `src/lib/auth/club-access.ts`'s `resolveClubAccess`, `src/lib/page-header-context.tsx`'s `usePageHeader`, `src/lib/format.ts`'s `formatRelativeTime` exactly as they exist — do not modify any of them.
- No PostgREST relation embedding anywhere.
- No shadcn/`@base-ui/react` components — hand-rolled Tailwind, matching every prior screen.
- Every labeled form field needs `htmlFor`/`id` pairing.
- Migration files follow the existing `YYYYMMDDHHMMSS_description.sql` naming, applied via `supabase db push --linked` against the live linked project (ref `inlseklfbptgjketdnpe`) — Cottonmouth is an active trial customer using Dispensing regularly; this is the 5th live modification to `create_dispense_order`, same verification discipline as every prior one.
- pnpm exclusively, Node via `.nvmrc` (run `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use` before any command — fall back to `node_modules/.bin/tsc`/`node_modules/.bin/next`/`node_modules/.bin/vitest` directly if this environment's pnpm/corepack shim still breaks).
- Commit messages plain, imperative. Work on branch `master` directly (standing consent from all prior phases).
- `CartItem`/`DispenseOrderItem`/`DispenseOrder` (`src/lib/dispensing.ts`), `Product` (`src/lib/products.ts`), `ProductCategoryRow` (`src/lib/categories.ts`), `MemberListRow` (`src/lib/members.ts`) confirmed against the actual current files — no drift.

---

### Task 1: Migration — `staff_email` column + gift-flag enforcement (6th `create_dispense_order` change overall, 5th functional one)

**Files:**
- Create: `supabase/migrations/20260816190000_gift_visibility.sql`

**Interfaces:**
- Produces: `dispense_orders.staff_email text` (nullable). `create_dispense_order(p_club_id uuid, p_member_id uuid, p_items jsonb, p_staff_email text) returns dispense_orders` — signature gains one new required parameter, `p_items` entries marked `is_gift: true` are now rejected server-side unless the product's `flags` array contains `'gift'`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260816190000_gift_visibility.sql`:

```sql
alter table dispense_orders add column staff_email text;

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

- [ ] **Step 2: Apply the migration**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use && supabase db push --linked`
Expected: applies cleanly.

- [ ] **Step 3: Verify nothing is left pending**

Run: `supabase db push --linked --dry-run`
Expected: no pending migrations listed.

- [ ] **Step 4: Verify `security invoker` is preserved and the new column exists**

```sql
select proname, prosecdef from pg_proc where proname = 'create_dispense_order';
```
Expected: one row, `prosecdef = false`.

```sql
select column_name, is_nullable from information_schema.columns
where table_name = 'dispense_orders' and column_name = 'staff_email';
```
Expected: one row, nullable.

- [ ] **Step 5: Scoped manual smoke test — gift-flag enforcement + `staff_email`**

Using the service-role admin client, create a throwaway club with 2 products (stock 20, `token_price` 40 each — one WITH `flags: ['gift']`, one with `flags: []`) and 1 member (`token_balance` 500), plus one `product_categories` row (`products.category_id` is required — reference its id on both products). Mirror `tests/rls/fixtures.ts`'s `seedClub` approach, not the shared fixture function itself.

Sign in as the club's admin user (the function is `security invoker` — it must be called as an authenticated session, not the service-role client).

(a) Call `create_dispense_order` with `p_items = [{"product_id": "<non-giftable>", "qty": 1, "is_gift": true}]` and a real `p_staff_email`. Confirm it raises an exception naming the product as not giftable, and confirm stock/balance are completely unchanged afterward.

(b) Call it with `p_items = [{"product_id": "<giftable>", "qty": 1, "is_gift": true, "gift_reason": "Loyalty"}]`. Confirm it succeeds, `token_total = 0`, and the returned row's `staff_email` matches what was passed.

Delete the throwaway club afterward (cascades).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260816190000_gift_visibility.sql
git commit -m "Add staff_email to dispense_orders and enforce the gift-flag on checkout"
```

---

### Task 2: Data layer + critical shared-fixture fix + tests

**Files:**
- Modify: `src/lib/dispensing.ts`
- Create: `src/lib/dispense-orders.ts`
- Modify: `tests/dispensing.test.ts`
- Test: `tests/dispense-orders.test.ts`

**Interfaces:**
- Consumes: Task 1's migration.
- Produces: `DispenseOrder.staffEmail`, `DispenseOrderHistoryRow`/`DispenseOrderHistoryItem` types and `getDispenseOrders(supabase, clubId, filters?)` (`src/lib/dispense-orders.ts`) — consumed by Task 3's UI.

- [ ] **Step 1: Update `src/lib/dispensing.ts`**

Add `staffEmail: string | null;` to `DispenseOrder` (after `tokenTotal: number;`) and `DispenseOrderRow` (after `token_total: number;`):

```ts
export type DispenseOrder = {
  id: string;
  memberId: string;
  tokenTotal: number;
  staffEmail: string | null;
  items: DispenseOrderItem[];
  createdAt: string;
};

type DispenseOrderRow = {
  id: string;
  member_id: string;
  token_total: number;
  staff_email: string | null;
  items: DispenseOrderItem[];
  created_at: string;
};
```

Change `createDispenseOrder` to resolve the caller's email and pass it as `p_staff_email` — the function's own external signature (`supabase, clubId, memberId, items`) does NOT change, so no caller anywhere in the codebase needs updating:

```ts
export async function createDispenseOrder(
  supabase: SupabaseClient,
  clubId: string,
  memberId: string,
  items: CartItem[],
): Promise<DispenseOrder> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const { data, error } = await supabase.rpc("create_dispense_order", {
    p_club_id: clubId,
    p_member_id: memberId,
    p_items: items.map((i) => ({
      product_id: i.productId,
      qty: i.qty,
      is_gift: i.isGift ?? false,
      gift_reason: i.giftReason ?? null,
    })),
    p_staff_email: user.email ?? null,
  });
  if (error) throw error;

  // The function is declared `returns dispense_orders` (a single
  // composite row, not `setof`), so `data` is a single object, not an
  // array — same pattern already established by record_donation.
  const row = data as DispenseOrderRow;
  return {
    id: row.id,
    memberId: row.member_id,
    tokenTotal: row.token_total,
    staffEmail: row.staff_email,
    items: row.items,
    createdAt: row.created_at,
  };
}
```

- [ ] **Step 2: Write `src/lib/dispense-orders.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DispenseOrderItem } from "@/lib/dispensing";

export type DispenseOrderHistoryItem = DispenseOrderItem;

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

type DispenseOrderHistoryDbRow = {
  id: string;
  member_id: string;
  staff_email: string | null;
  token_total: number;
  items: DispenseOrderHistoryItem[];
  created_at: string;
};

export async function getDispenseOrders(
  supabase: SupabaseClient,
  clubId: string,
  filters?: { giftsOnly?: boolean },
): Promise<DispenseOrderHistoryRow[]> {
  const { data: rows, error } = await supabase
    .from("dispense_orders")
    .select("id, member_id, staff_email, token_total, items, created_at")
    .eq("club_id", clubId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;

  const list = (rows ?? []) as DispenseOrderHistoryDbRow[];
  if (list.length === 0) return [];

  const memberIds = [...new Set(list.map((r) => r.member_id))];
  const { data: members, error: membersError } = await supabase
    .from("members")
    .select("id, first, last")
    .in("id", memberIds);
  if (membersError) throw membersError;
  const nameById = new Map((members ?? []).map((m) => [m.id as string, `${m.first} ${m.last}`]));

  const mapped = list.map((row) => ({
    id: row.id,
    memberId: row.member_id,
    memberName: nameById.get(row.member_id) ?? "—",
    staffEmail: row.staff_email,
    tokenTotal: row.token_total,
    items: row.items,
    hasGift: row.items.some((i) => i.isGift),
    createdAt: row.created_at,
  }));

  return filters?.giftsOnly ? mapped.filter((o) => o.hasGift) : mapped;
}
```

- [ ] **Step 3: Fix the shared `seedProduct` helper in `tests/dispensing.test.ts`**

`products.flags` defaults to `'{}'` and `seedProduct` currently never sets it — every one of the 4 existing gift tests would fail the moment flag-enforcement lands, because their test products were never flagged giftable. Change `seedProduct`'s signature to take an optional 4th parameter:

```ts
async function seedProduct(clubId: string, tokenPrice: number, stock: number, flags: string[] = []) {
  const admin = createAdminClient();
  const { data: category, error: categoryError } = await admin
    .from("product_categories")
    .select("id")
    .eq("club_id", clubId)
    .limit(1)
    .single();
  if (categoryError) throw categoryError;

  const { data: product, error } = await admin
    .from("products")
    .insert({
      club_id: clubId,
      name: `Dispense Test Product ${crypto.randomUUID().slice(0, 8)}`,
      category_id: category.id,
      unit: "per 1g",
      token_price: tokenPrice,
      sell_price: tokenPrice * 1.5,
      flags,
    })
    .select()
    .single();
  if (error) throw error;
  cleanupProductIds.push(product.id);

  const { data: move, error: moveError } = await admin
    .from("inventory_moves")
    .insert({ club_id: clubId, product_id: product.id, type: "PURCHASE", qty: stock })
    .select()
    .single();
  if (moveError) throw moveError;
  cleanupMoveIds.push(move.id);

  return product;
}
```

Every existing call site (the large majority of this file's tests, none of which pass a 4th argument) keeps compiling and behaving identically — `flags` defaults to `[]`, exactly what was already happening implicitly.

- [ ] **Step 4: Update the 4 existing gift tests in the `"gifting"` describe block to seed a flagged product**

In each of these 4 tests (`"checks out a gift-only order at tokenTotal 0..."`, `"charges only the paid line in a mixed paid+gift order..."`, `"succeeds for an all-gift order even at zero balance"`, `"a normal order with no gift lines has isGift:false on every item (regression)"`), every `seedProduct(...)` call whose product is used in a gift line (`isGift: true`) needs `['gift']` as the 4th argument. Concretely, change:

```ts
    const product = await seedProduct(data.clubA.clubId, 150, 50);
```

to:

```ts
    const product = await seedProduct(data.clubA.clubId, 150, 50, ["gift"]);
```

wherever that product is later used with `isGift: true`. In the mixed-order test specifically, only the product used in the GIFT line needs the flag — the paid-line product's `seedProduct` call stays as `seedProduct(data.clubA.clubId, 40, 50)` (no flag, matching a normal purchase). In the regression test (no gift lines at all), no flag is needed since nothing is marked `isGift: true` there.

- [ ] **Step 5: Add 2 new tests to the `"gifting"` describe block**

```ts
  it("rejects a gift line for a product without the gift flag", async () => {
    const product = await seedProduct(data.clubA.clubId, 40, 50);
    const member = await seedMemberWithBalance(data.clubA.clubId, 1000);

    await expect(
      createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
        { productId: product.id, qty: 1, isGift: true },
      ]),
    ).rejects.toThrow("is not marked as giftable");

    expect(await getStock(product.id)).toBe(50);
    expect(await getBalance(member.id)).toBe(1000);
  });

  it("succeeds and records staffEmail for a gift line on a flagged product", async () => {
    const product = await seedProduct(data.clubA.clubId, 40, 50, ["gift"]);
    const member = await seedMemberWithBalance(data.clubA.clubId, 1000);

    const order = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: product.id, qty: 1, isGift: true },
    ]);
    cleanupOrderIds.push(order.id);

    expect(order.tokenTotal).toBe(0);
    expect(order.staffEmail).toBe(data.clubA.adminEmail);
  });
```

- [ ] **Step 6: Write `tests/dispense-orders.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedTenants, cleanupTenants, signInAs, type SeededData } from "./rls/fixtures";
import { createAdminClient } from "@/lib/supabase/admin";
import { createDispenseOrder } from "@/lib/dispensing";
import { getDispenseOrders } from "@/lib/dispense-orders";

let data: SeededData;
let clubAClient: SupabaseClient;
let clubBClient: SupabaseClient;
const cleanupOrderIds: string[] = [];
const cleanupMoveIds: string[] = [];
const cleanupProductIds: string[] = [];
const cleanupMemberIds: string[] = [];

beforeAll(async () => {
  data = await seedTenants();
  clubAClient = await signInAs(data.clubA.adminEmail, data.clubA.adminPassword);
  clubBClient = await signInAs(data.clubB.adminEmail, data.clubB.adminPassword);
}, 30000);

afterAll(async () => {
  const admin = createAdminClient();
  if (cleanupOrderIds.length > 0) {
    await admin.from("dispense_orders").delete().in("id", cleanupOrderIds);
  }
  if (cleanupMoveIds.length > 0) {
    await admin.from("inventory_moves").delete().in("id", cleanupMoveIds);
  }
  if (cleanupProductIds.length > 0) {
    await admin.from("products").delete().in("id", cleanupProductIds);
  }
  if (cleanupMemberIds.length > 0) {
    await admin.from("members").delete().in("id", cleanupMemberIds);
  }
  if (data) {
    await cleanupTenants(data);
  }
}, 30000);

async function seedProduct(clubId: string, tokenPrice: number, stock: number, flags: string[] = []) {
  const admin = createAdminClient();
  const { data: category, error: categoryError } = await admin
    .from("product_categories")
    .select("id")
    .eq("club_id", clubId)
    .limit(1)
    .single();
  if (categoryError) throw categoryError;

  const { data: product, error } = await admin
    .from("products")
    .insert({
      club_id: clubId,
      name: `Order History Test Product ${crypto.randomUUID().slice(0, 8)}`,
      category_id: category.id,
      unit: "per 1g",
      token_price: tokenPrice,
      sell_price: tokenPrice * 1.5,
      flags,
    })
    .select()
    .single();
  if (error) throw error;
  cleanupProductIds.push(product.id);

  const { data: move, error: moveError } = await admin
    .from("inventory_moves")
    .insert({ club_id: clubId, product_id: product.id, type: "PURCHASE", qty: stock })
    .select()
    .single();
  if (moveError) throw moveError;
  cleanupMoveIds.push(move.id);

  return product;
}

async function seedMemberWithBalance(clubId: string, tokenBalance: number) {
  const admin = createAdminClient();
  const { data: member, error } = await admin
    .from("members")
    .insert({
      club_id: clubId,
      code: `HIST-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      first: "History",
      last: "Test",
      type: "Full member",
      status: "active",
      token_balance: tokenBalance,
    })
    .select()
    .single();
  if (error) throw error;
  cleanupMemberIds.push(member.id);
  return member;
}

describe("getDispenseOrders", () => {
  it("returns club A's orders newest-first with member names resolved, isolated from club B", async () => {
    const productA = await seedProduct(data.clubA.clubId, 40, 50);
    const memberA = await seedMemberWithBalance(data.clubA.clubId, 1000);
    const productB = await seedProduct(data.clubB.clubId, 40, 50);
    const memberB = await seedMemberWithBalance(data.clubB.clubId, 1000);

    const first = await createDispenseOrder(clubAClient, data.clubA.clubId, memberA.id, [
      { productId: productA.id, qty: 1 },
    ]);
    cleanupOrderIds.push(first.id);
    const second = await createDispenseOrder(clubAClient, data.clubA.clubId, memberA.id, [
      { productId: productA.id, qty: 1 },
    ]);
    cleanupOrderIds.push(second.id);
    const otherClubOrder = await createDispenseOrder(clubBClient, data.clubB.clubId, memberB.id, [
      { productId: productB.id, qty: 1 },
    ]);
    cleanupOrderIds.push(otherClubOrder.id);

    const orders = await getDispenseOrders(clubAClient, data.clubA.clubId);
    const ids = orders.map((o) => o.id);
    expect(ids).not.toContain(otherClubOrder.id);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));

    const found = orders.find((o) => o.id === second.id);
    expect(found?.memberName).toBe("History Test");
  });

  it("giftsOnly filters to only orders containing at least one gift line", async () => {
    const giftableProduct = await seedProduct(data.clubA.clubId, 40, 50, ["gift"]);
    const plainProduct = await seedProduct(data.clubA.clubId, 40, 50);
    const member = await seedMemberWithBalance(data.clubA.clubId, 1000);

    const giftOrder = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: giftableProduct.id, qty: 1, isGift: true },
    ]);
    cleanupOrderIds.push(giftOrder.id);
    const plainOrder = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: plainProduct.id, qty: 1 },
    ]);
    cleanupOrderIds.push(plainOrder.id);

    const giftsOnly = await getDispenseOrders(clubAClient, data.clubA.clubId, { giftsOnly: true });
    const giftsOnlyIds = giftsOnly.map((o) => o.id);
    expect(giftsOnlyIds).toContain(giftOrder.id);
    expect(giftsOnlyIds).not.toContain(plainOrder.id);
  });
});
```

- [ ] **Step 7: Run the affected test files**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use && node_modules/.bin/vitest run tests/dispensing.test.ts tests/dispense-orders.test.ts`
Expected: all tests pass, including the 4 updated gift tests, 2 new gift tests, and 2 new `getDispenseOrders` tests.

- [ ] **Step 8: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no output, exit 0. (Will still show errors in `dispensing-panel.tsx` if it references anything from this task's changed types in a way Task 3 hasn't caught up on — but this task doesn't touch that file, so this should already be clean project-wide.)

- [ ] **Step 9: Commit**

```bash
git add src/lib/dispensing.ts src/lib/dispense-orders.ts tests/dispensing.test.ts tests/dispense-orders.test.ts
git commit -m "Add order history data layer, staffEmail, and fix shared fixture for gift-flag tests"
```

---

### Task 3: UI — gated gift toggle + Order History screen

**Files:**
- Create: `src/app/[clubSlug]/orders/page.tsx`
- Create: `src/app/[clubSlug]/orders/orders-header.tsx`
- Create: `src/app/[clubSlug]/orders/orders-table.tsx`
- Modify: `src/app/[clubSlug]/dispense/dispensing-panel.tsx`
- Modify: `src/components/app-shell/sidebar.tsx`

**Interfaces:**
- Consumes: Task 2's `getDispenseOrders`, `DispenseOrderHistoryRow` from `@/lib/dispense-orders`.

- [ ] **Step 1: Gate the gift toggle in `dispensing-panel.tsx` behind the product's `gift` flag**

Change `cartLines`' derivation to add `isGiftable`:

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

Wrap the existing 🎁 toggle button in a conditional on `l.isGiftable` — change:

```tsx
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
```

to:

```tsx
                  {l.isGiftable && (
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
                  )}
```

Everything else in the file (the reason input, struck-through price, footer summary, `handleCheckout`) is unchanged — a line for a non-giftable product simply never has a way to become `isGift: true` through this UI, since the only control that sets it is now conditionally absent.

- [ ] **Step 2: Write `src/app/[clubSlug]/orders/orders-header.tsx`**

```tsx
"use client";

import { usePageHeader } from "@/lib/page-header-context";

export function OrdersHeader() {
  usePageHeader({ title: "Order history", subtitle: "Every checkout, including gifts" });
  return null;
}
```

- [ ] **Step 3: Write `src/app/[clubSlug]/orders/orders-table.tsx`**

```tsx
"use client";

import { useMemo, useState } from "react";
import { formatRelativeTime } from "@/lib/format";
import type { DispenseOrderHistoryRow } from "@/lib/dispense-orders";

const FILTERS = ["All", "Gifts only"] as const;
type Filter = (typeof FILTERS)[number];

export function OrdersTable({ orders }: { orders: DispenseOrderHistoryRow[] }) {
  const [filter, setFilter] = useState<Filter>("All");

  const filtered = useMemo(() => {
    return filter === "Gifts only" ? orders.filter((o) => o.hasGift) : orders;
  }, [orders, filter]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-[7px]">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className="rounded-[8px] border px-3 py-[7px] text-[12.5px] font-medium"
            style={
              filter === f
                ? { background: "var(--primary)", borderColor: "var(--primary)", color: "#fff" }
                : { background: "var(--card)", borderColor: "var(--border)", color: "#4a4e45" }
            }
          >
            {f}
          </button>
        ))}
      </div>

      <div className="rounded-card border border-border bg-card">
        {orders.length === 0 ? (
          <div className="px-6 py-16 text-center text-[13.5px] text-[#6b6f66]">No orders yet.</div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-16 text-center text-[13.5px] text-[#6b6f66]">No orders match this filter.</div>
        ) : (
          <>
            <div className="grid grid-cols-[140px_1fr_2fr_90px_100px] gap-3 border-b border-border bg-muted px-[18px] py-3 text-[11px] font-semibold uppercase tracking-[.05em] text-[#8a8e83]">
              <div>Staff</div>
              <div>Member</div>
              <div>Items</div>
              <div>Total</div>
              <div>When</div>
            </div>
            {filtered.map((o) => (
              <div
                key={o.id}
                className="grid grid-cols-[140px_1fr_2fr_90px_100px] items-center gap-3 border-b border-[#f4f2ea] px-[18px] py-3 last:border-b-0"
              >
                <div className="truncate text-[12px] text-[#6b6f66]">{o.staffEmail ?? "—"}</div>
                <div className="truncate text-[13px] font-medium">{o.memberName}</div>
                <div className="truncate text-[12px] text-[#6b6f66]">
                  {o.items.map((i, idx) => (
                    <span key={i.productId}>
                      {idx > 0 ? ", " : ""}
                      {i.isGift ? "🎁 " : ""}
                      {i.productName} ×{i.qty}
                    </span>
                  ))}
                </div>
                <div className="font-mono text-[13px] font-semibold text-primary">{o.tokenTotal}</div>
                <div className="text-[11px] text-[#9a9e93]">{formatRelativeTime(o.createdAt)}</div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Write `src/app/[clubSlug]/orders/page.tsx`**

```tsx
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import { getDispenseOrders } from "@/lib/dispense-orders";
import { OrdersHeader } from "./orders-header";
import { OrdersTable } from "./orders-table";

export default async function OrdersPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const supabase = await createClient();
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();
  if (access.role !== "admin") notFound();

  const orders = await getDispenseOrders(supabase, access.clubId);

  return (
    <>
      <OrdersHeader />
      <OrdersTable orders={orders} />
    </>
  );
}
```

- [ ] **Step 5: Add the sidebar nav entry**

In `src/components/app-shell/sidebar.tsx`, add a new entry to the `"Accounting"` group's `items` array, immediately after the existing `till` entry:

```ts
      { key: "orders", label: "Order history", path: "/orders", dot: "var(--tenant-accent-5)", adminOnly: true },
```

The full `"Accounting"` group becomes:

```ts
  {
    label: "Accounting",
    items: [
      { key: "donations", label: "Donations", path: "/donations", dot: "var(--tenant-accent-5)" },
      { key: "till", label: "Till & shifts", path: "/till", dot: "var(--tenant-accent-4)" },
      { key: "orders", label: "Order history", path: "/orders", dot: "var(--tenant-accent-5)", adminOnly: true },
    ],
  },
```

- [ ] **Step 6: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no output, exit 0 — project-wide clean, first point in this plan where that's expected.

- [ ] **Step 7: Build**

Run: `node_modules/.bin/next build`
Expected: clean build, `/[clubSlug]/orders` present in the route table, no regressions.

- [ ] **Step 8: Manual smoke test**

Using the demo club (`admin@gaafd.test` / `SmokeTest2026!`, slug `demo`):
- In Products, confirm a product WITHOUT "Gifting allowed" checked shows no 🎁 toggle on its cart line in Dispensing.
- Check "Gifting allowed" on a product, confirm the 🎁 toggle now appears for that product's cart line.
- Complete one normal order and one order with a gifted line.
- Go to "Order history" (new sidebar item under Accounting) — confirm both orders appear, newest first, with the gifted line marked 🎁 in the items column and the correct staff email/member name/total.
- Click "Gifts only" — confirm only the order containing a gift shows.
- Sign in as a staff-role user (if one exists for this club) and confirm "Order history" is absent from their sidebar and `/demo/orders` 404s for them directly.

- [ ] **Step 9: Commit**

```bash
git add "src/app/[clubSlug]/orders" "src/app/[clubSlug]/dispense/dispensing-panel.tsx" src/components/app-shell/sidebar.tsx
git commit -m "Add Order History screen and gate the gift toggle behind the product flag"
```
