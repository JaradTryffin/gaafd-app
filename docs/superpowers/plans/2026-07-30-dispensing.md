# Dispensing / POS Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `/[clubSlug]/dispense` — a real POS checkout: member search, product grid, cart, and an atomic checkout that debits tokens and decrements stock together. The largest and most transactionally complex screen in the project.

**Architecture:** Two migrations (a new `dispense_orders` table + RLS, then a substantially more complex atomic checkout function than any prior RPC), a data layer wrapping that function, then a single UI task. Split into 4 tasks (vs. 3 for Donations/Inventory) because the schema and the checkout function are each complex enough to deserve their own focused review.

**Tech Stack:** Next.js App Router, TypeScript, Supabase JS client (`.rpc()`), Vitest.

## Global Constraints

- Reuse `src/lib/supabase/server.ts`, `src/lib/auth/club-access.ts`'s `resolveClubAccess`, `src/lib/page-header-context.tsx`'s `usePageHeader`, `src/lib/toast-context.tsx`'s `useToast`, `src/lib/products.ts`'s `getProducts`, `src/lib/members.ts`'s `listMembers` exactly as they exist — do not modify any of them.
- No PostgREST relation embedding anywhere.
- No shadcn/`@base-ui/react` components — hand-rolled Tailwind markup, matching every prior screen.
- Every labeled form field needs `htmlFor`/`id` pairing.
- Migration files follow the existing `YYYYMMDDHHMMSS_description.sql` naming, applied via `supabase db push --linked` against the live linked project (ref `inlseklfbptgjketdnpe`).
- pnpm exclusively, Node via `.nvmrc` (run `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use` before any command).
- Commit messages plain, imperative. Work on branch `master` directly (standing consent from all prior phases).
- `Product` (`src/lib/products.ts`) fields used in this plan: `id, name, category, unit, tokenPrice, active, stock`. `MemberListRow` (`src/lib/members.ts`) fields used: `id, first, last, code, type, tokenBalance`. Both confirmed against the actual current files — no drift.

---

### Task 1: Migration — `dispense_orders` schema + RLS

**Files:**
- Create: `supabase/migrations/20260730180000_dispense_orders_schema.sql`

**Interfaces:**
- Produces: the `dispense_orders` table and `inventory_moves.order_id` column — consumed by Task 2's function.

No application code in this task — pure schema, verified against the live project directly.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260730180000_dispense_orders_schema.sql`:

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

alter table dispense_orders enable row level security;

create policy dispense_orders_select on dispense_orders for select to authenticated
  using (club_id in (select my_club_ids()));

create policy dispense_orders_insert on dispense_orders for insert to authenticated
  with check (club_id in (select my_club_ids()));
```

- [ ] **Step 2: Apply the migration**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use && supabase db push --linked`
Expected: lists the new migration, applies it, ends with `Finished supabase db push.`

- [ ] **Step 3: Verify nothing is left pending**

Run: `supabase db push --linked --dry-run`
Expected: no pending migrations listed.

- [ ] **Step 4: Verify against the live project**

```sql
select column_name, data_type, is_nullable from information_schema.columns
where table_name = 'dispense_orders' order by ordinal_position;
```
Expected: `id, club_id, member_id, token_total, items, staff_id, created_at` with `club_id`/`member_id`/`token_total`/`items` `NOT NULL`, `staff_id` nullable.

```sql
select policyname, cmd from pg_policies
where schemaname = 'public' and tablename = 'dispense_orders';
```
Expected: exactly 2 rows — `dispense_orders_select` (SELECT), `dispense_orders_insert` (INSERT). No UPDATE/DELETE policy, no policy referencing `is_platform()`.

```sql
select column_name, is_nullable from information_schema.columns
where table_name = 'inventory_moves' and column_name = 'order_id';
```
Expected: one row, nullable.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260730180000_dispense_orders_schema.sql
git commit -m "Add dispense_orders table and append-only RLS policies"
```

---

### Task 2: Migration — `create_dispense_order` checkout function

**Files:**
- Create: `supabase/migrations/20260730180100_create_dispense_order_function.sql`

**Interfaces:**
- Consumes: Task 1's `dispense_orders` table and `inventory_moves.order_id` column.
- Produces: the `create_dispense_order(p_club_id uuid, p_member_id uuid, p_items jsonb) returns dispense_orders` function — consumed by Task 3 via `supabase.rpc("create_dispense_order", {...})`.

No application code in this task.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260730180100_create_dispense_order_function.sql`:

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
    v_product_id := (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'qty')::integer;

    if v_qty is null or v_qty <= 0 then
      raise exception 'Invalid quantity for a line item';
    end if;

    select p.name, p.unit, p.token_price into v_product_name, v_unit, v_token_price
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

  for v_item in select * from jsonb_array_elements(p_items)
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

- [ ] **Step 4: Verify the function exists**

```sql
select proname from pg_proc where proname = 'create_dispense_order';
```
Expected: one row.

- [ ] **Step 5: Scoped manual E2E smoke test**

This is a scoped smoke test, not the full correctness matrix — Task 3's automated suite covers atomicity/rejection paths exhaustively. Using the service-role admin client, create a throwaway club with 1 product (stock 20, `token_price` 10) and 1 member (`token_balance` 100) — mirror `tests/rls/fixtures.ts`'s `seedClub` approach (minimal `clubs`/`club_users`/`members`/`products`/`inventory_moves` inserts), not the shared fixture function itself.

(a) Call `create_dispense_order` with a single-line item `{product_id, qty: 3}`. Confirm it returns a `dispense_orders` row with `token_total = 30` and `items` containing one correctly-shaped snapshot entry. Confirm the product's derived stock (query `product_stock`) dropped from 20 to 17. Confirm the member's `token_balance` dropped from 100 to 70. Confirm an `inventory_moves` row exists with `type = 'SALE'`, `qty = -3`, `order_id` = the new order's id.

(b) Call it again requesting `qty` exceeding the remaining stock (e.g. 100). Confirm it raises an exception, and confirm NEITHER the product's stock NOR the member's `token_balance` changed from step (a)'s ending values (17 and 70 respectively) — proving no partial write happened.

Delete the throwaway club afterward (cascades to member/product/moves/orders).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260730180100_create_dispense_order_function.sql
git commit -m "Add create_dispense_order function for atomic checkout (stock + token debit)"
```

---

### Task 3: Dispensing data layer

**Files:**
- Create: `src/lib/dispensing.ts`
- Test: `tests/dispensing.test.ts`

**Interfaces:**
- Consumes: Task 2's `create_dispense_order` function.
- Produces: `type CartItem`, `type DispenseOrderItem`, `type DispenseOrder`, `createDispenseOrder(supabase, clubId, memberId, items): Promise<DispenseOrder>` — consumed by Task 4.

- [ ] **Step 1: Write the failing tests**

Create `tests/dispensing.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedTenants, cleanupTenants, signInAs, type SeededData } from "./rls/fixtures";
import { createAdminClient } from "@/lib/supabase/admin";
import { createDispenseOrder } from "@/lib/dispensing";

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

async function seedProduct(clubId: string, tokenPrice: number, stock: number) {
  const admin = createAdminClient();
  const { data: product, error } = await admin
    .from("products")
    .insert({
      club_id: clubId,
      name: `Dispense Test Product ${crypto.randomUUID().slice(0, 8)}`,
      category: "Flower",
      unit: "per 1g",
      token_price: tokenPrice,
      sell_price: tokenPrice * 1.5,
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
      code: `DISP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      first: "Dispense",
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

async function getStock(productId: string): Promise<number> {
  const admin = createAdminClient();
  const { data: row } = await admin
    .from("product_stock")
    .select("stock")
    .eq("product_id", productId)
    .maybeSingle();
  return row?.stock ?? 0;
}

async function getBalance(memberId: string): Promise<number> {
  const admin = createAdminClient();
  const { data: row } = await admin
    .from("members")
    .select("token_balance")
    .eq("id", memberId)
    .single();
  return row!.token_balance;
}

describe("createDispenseOrder", () => {
  it("completes a multi-line order: decrements stock per line, debits the token total, snapshots items", async () => {
    const productA = await seedProduct(data.clubA.clubId, 40, 50);
    const productB = await seedProduct(data.clubA.clubId, 20, 30);
    const member = await seedMemberWithBalance(data.clubA.clubId, 200);

    const order = await createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
      { productId: productA.id, qty: 2 },
      { productId: productB.id, qty: 3 },
    ]);
    cleanupOrderIds.push(order.id);

    expect(order.tokenTotal).toBe(2 * 40 + 3 * 20);
    expect(order.items).toHaveLength(2);
    expect(order.items.find((i) => i.productId === productA.id)?.lineTotal).toBe(80);
    expect(order.items.find((i) => i.productId === productB.id)?.lineTotal).toBe(60);

    expect(await getStock(productA.id)).toBe(48);
    expect(await getStock(productB.id)).toBe(27);
    expect(await getBalance(member.id)).toBe(200 - 140);
  });

  it("rejects an order when requested qty exceeds current stock", async () => {
    const product = await seedProduct(data.clubA.clubId, 40, 5);
    const member = await seedMemberWithBalance(data.clubA.clubId, 1000);

    await expect(
      createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [{ productId: product.id, qty: 10 }]),
    ).rejects.toThrow();

    expect(await getStock(product.id)).toBe(5);
    expect(await getBalance(member.id)).toBe(1000);
  });

  it("rejects an order when the member's token balance is insufficient", async () => {
    const product = await seedProduct(data.clubA.clubId, 100, 50);
    const member = await seedMemberWithBalance(data.clubA.clubId, 50);

    await expect(
      createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [{ productId: product.id, qty: 1 }]),
    ).rejects.toThrow();

    expect(await getStock(product.id)).toBe(50);
    expect(await getBalance(member.id)).toBe(50);
  });

  it("rejects a product belonging to a different club", async () => {
    const member = await seedMemberWithBalance(data.clubA.clubId, 1000);

    await expect(
      createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
        { productId: data.clubB.productId, qty: 1 },
      ]),
    ).rejects.toThrow();
  });

  it("rejects a member belonging to a different club", async () => {
    const product = await seedProduct(data.clubA.clubId, 40, 50);

    await expect(
      createDispenseOrder(clubAClient, data.clubA.clubId, data.clubB.memberId, [
        { productId: product.id, qty: 1 },
      ]),
    ).rejects.toThrow("Member not found in this club");
  });

  it("rolls back the entire order when any single line is invalid, leaving earlier lines' stock untouched", async () => {
    const productA = await seedProduct(data.clubA.clubId, 40, 50);
    const productB = await seedProduct(data.clubA.clubId, 20, 2);
    const member = await seedMemberWithBalance(data.clubA.clubId, 1000);

    await expect(
      createDispenseOrder(clubAClient, data.clubA.clubId, member.id, [
        { productId: productA.id, qty: 5 },
        { productId: productB.id, qty: 10 },
      ]),
    ).rejects.toThrow();

    expect(await getStock(productA.id)).toBe(50);
    expect(await getStock(productB.id)).toBe(2);
    expect(await getBalance(member.id)).toBe(1000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/dispensing.test.ts`
Expected: FAIL — `Cannot find module '@/lib/dispensing'`. (Requires Tasks 1-2's migrations to already be live.)

- [ ] **Step 3: Implement**

Create `src/lib/dispensing.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

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

type DispenseOrderRow = {
  id: string;
  member_id: string;
  token_total: number;
  items: DispenseOrderItem[];
  created_at: string;
};

export async function createDispenseOrder(
  supabase: SupabaseClient,
  clubId: string,
  memberId: string,
  items: CartItem[],
): Promise<DispenseOrder> {
  const { data, error } = await supabase.rpc("create_dispense_order", {
    p_club_id: clubId,
    p_member_id: memberId,
    p_items: items.map((i) => ({ product_id: i.productId, qty: i.qty })),
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
    items: row.items,
    createdAt: row.created_at,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/dispensing.test.ts`
Expected: PASS, all 6 tests green. Live Supabase project — this will take longer than a mocked suite.

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/dispensing.ts tests/dispensing.test.ts
git commit -m "Add dispensing data layer (atomic checkout)"
```

---

### Task 4: Dispensing screen UI

**Files:**
- Create: `src/app/[clubSlug]/dispense/page.tsx`
- Create: `src/app/[clubSlug]/dispense/dispensing-header.tsx`
- Create: `src/app/[clubSlug]/dispense/dispensing-panel.tsx`
- Create: `src/app/[clubSlug]/dispense/actions.ts`

**Interfaces:**
- Consumes: `createDispenseOrder`, `type CartItem`, `type DispenseOrder` from `src/lib/dispensing.ts` (Task 3). `getProducts`/`type Product`/`type ProductCategory` from `src/lib/products.ts` (existing). `listMembers`/`type MemberListRow` from `src/lib/members.ts` (existing). `resolveClubAccess` from `src/lib/auth/club-access.ts` (existing). `usePageHeader` from `src/lib/page-header-context.tsx` (existing). `useToast` from `src/lib/toast-context.tsx` (existing).

This task has no test file — verified via `tsc`/`build`/manual smoke test, per this project's established convention for UI-only tasks.

- [ ] **Step 1: Create the header component**

Create `src/app/[clubSlug]/dispense/dispensing-header.tsx`:

```tsx
"use client";

import { usePageHeader } from "@/lib/page-header-context";

export function DispensingHeader() {
  usePageHeader({ title: "Dispensing", subtitle: "Redeem member tokens for product" });
  return null;
}
```

- [ ] **Step 2: Create the server action**

Create `src/app/[clubSlug]/dispense/actions.ts`:

```ts
"use server";

import { createClient } from "@/lib/supabase/server";
import { createDispenseOrder, type CartItem, type DispenseOrder } from "@/lib/dispensing";

export async function createDispenseOrderAction(
  clubId: string,
  memberId: string,
  items: CartItem[],
): Promise<{ ok: true; order: DispenseOrder } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const order = await createDispenseOrder(supabase, clubId, memberId, items);
    return { ok: true, order };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to complete dispense" };
  }
}
```

- [ ] **Step 3: Create the panel component**

Create `src/app/[clubSlug]/dispense/dispensing-panel.tsx`:

```tsx
"use client";

import { useMemo, useState, useTransition } from "react";
import { useToast } from "@/lib/toast-context";
import { createDispenseOrderAction } from "./actions";
import type { Product, ProductCategory } from "@/lib/products";
import type { MemberListRow } from "@/lib/members";

const CATEGORIES: (ProductCategory | "All")[] = [
  "All",
  "Flower",
  "Pre-rolls",
  "Edibles",
  "Concentrate",
  "Accessory",
];

export function DispensingPanel({
  clubId,
  products: initialProducts,
  members,
}: {
  clubId: string;
  products: Product[];
  members: MemberListRow[];
}) {
  const { showToast } = useToast();
  const [products, setProducts] = useState(initialProducts);
  const [categoryFilter, setCategoryFilter] = useState<ProductCategory | "All">("All");
  const [memberSearch, setMemberSearch] = useState("");
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [isCheckingOut, startCheckingOut] = useTransition();

  const selectedMember = members.find((m) => m.id === selectedMemberId) ?? null;

  const filteredProducts = useMemo(() => {
    return products.filter((p) => p.active && (categoryFilter === "All" || p.category === categoryFilter));
  }, [products, categoryFilter]);

  const memberResults = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return [];
    return members.filter((m) => `${m.first} ${m.last} ${m.code}`.toLowerCase().includes(q)).slice(0, 6);
  }, [members, memberSearch]);

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const cartLines = Object.entries(cart).map(([productId, qty]) => {
    const product = productById.get(productId);
    return {
      productId,
      qty,
      name: product?.name ?? "—",
      tokenPrice: product?.tokenPrice ?? 0,
      lineTotal: (product?.tokenPrice ?? 0) * qty,
    };
  });
  const cartCount = cartLines.reduce((sum, l) => sum + l.qty, 0);
  const cartTotal = cartLines.reduce((sum, l) => sum + l.lineTotal, 0);
  const balanceAfter = selectedMember ? selectedMember.tokenBalance - cartTotal : null;
  const canCheckout = Boolean(selectedMember) && cartCount > 0 && (balanceAfter ?? -1) >= 0;

  function addToCart(productId: string) {
    setCart((prev) => ({ ...prev, [productId]: (prev[productId] ?? 0) + 1 }));
  }

  function changeQty(productId: string, delta: number) {
    setCart((prev) => {
      const next = { ...prev };
      const qty = (next[productId] ?? 0) + delta;
      if (qty <= 0) {
        delete next[productId];
      } else {
        next[productId] = qty;
      }
      return next;
    });
  }

  function selectMember(memberId: string) {
    setSelectedMemberId(memberId);
    setMemberSearch("");
  }

  function handleCheckout() {
    setError(null);
    if (!selectedMember) {
      setError("Select a member first");
      return;
    }
    if (cartCount === 0) {
      setError("Add products to the order");
      return;
    }
    if ((balanceAfter ?? -1) < 0) {
      setError("Not enough tokens for this order");
      return;
    }
    const items = cartLines.map((l) => ({ productId: l.productId, qty: l.qty }));
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
      setSelectedMemberId(null);
    });
  }

  return (
    <div className="grid grid-cols-[1fr_380px] items-start gap-4">
      <div>
        {selectedMember ? (
          <div className="mb-3.5 flex items-center gap-3.5 rounded-card border border-border bg-card p-4">
            <div className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-accent text-base font-semibold text-primary">
              {selectedMember.first.charAt(0)}
              {selectedMember.last.charAt(0)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold">
                {selectedMember.first} {selectedMember.last}
              </div>
              <div className="text-[12px] text-[#6b6f66]">
                {selectedMember.type} · {selectedMember.code}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[11px] text-[#6b6f66]">Token balance</div>
              <div className="font-mono text-xl font-semibold text-primary">{selectedMember.tokenBalance}</div>
            </div>
            <button
              type="button"
              onClick={() => setSelectedMemberId(null)}
              className="rounded-[8px] border border-input bg-muted px-3 py-2 text-[12px] text-[#6b6f66]"
            >
              Change
            </button>
          </div>
        ) : (
          <div className="relative mb-3.5">
            <label htmlFor="dispenseMemberSearch" className="mb-1 block text-[11px] text-[#8a8e83]">
              Select a member to dispense to
            </label>
            <input
              id="dispenseMemberSearch"
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.target.value)}
              placeholder="Search members by name or code…"
              className="w-full rounded-[9px] border border-input bg-card px-3 py-2.5 text-[13px]"
            />
            {memberResults.length > 0 && (
              <div className="absolute left-0 right-0 top-full z-10 mt-1 rounded-[10px] border border-border bg-card shadow-lg">
                {memberResults.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => selectMember(m.id)}
                    className="flex w-full items-center gap-2.5 border-b border-[#f4f2ea] px-3 py-2.5 text-left last:border-b-0"
                  >
                    <div className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-primary">
                      {m.first.charAt(0)}
                      {m.last.charAt(0)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">
                        {m.first} {m.last}
                      </div>
                      <div className="text-[11px] text-[#9a9e93]">{m.code}</div>
                    </div>
                    <div className="font-mono text-[12px] text-primary">{m.tokenBalance} bal</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="mb-3 flex flex-wrap gap-[7px]">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategoryFilter(c)}
              className="rounded-[8px] border px-3 py-[7px] text-[12.5px] font-medium"
              style={
                categoryFilter === c
                  ? { background: "var(--primary)", borderColor: "var(--primary)", color: "#fff" }
                  : { background: "var(--card)", borderColor: "var(--border)", color: "#4a4e45" }
              }
            >
              {c}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
          {filteredProducts.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => addToCart(p.id)}
              className="overflow-hidden rounded-[13px] border border-border bg-card text-left"
            >
              <div className="flex h-[78px] items-center justify-center bg-accent font-mono text-[10px] text-[#8ba690]">
                {p.category}
              </div>
              <div className="px-3 py-2.5">
                <div className="text-[13px] font-semibold leading-tight">{p.name}</div>
                <div className="mt-0.5 text-[11px] text-[#8a8e83]">
                  {p.unit} · {p.stock} in stock
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <div className="font-mono text-[15px] font-semibold text-primary">
                    {p.tokenPrice}
                    <span className="text-[10px] font-normal text-[#8a8e83]"> tok</span>
                  </div>
                  <div className="flex h-6 w-6 items-center justify-center rounded-[7px] bg-accent text-[15px] font-semibold text-primary">
                    +
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="sticky top-0 flex max-h-[calc(100vh-150px)] flex-col rounded-card border border-border bg-card">
        <div className="border-b border-[#f0eee6] px-4 py-[15px] font-heading text-[15px] font-semibold">
          Order · redeem tokens
        </div>
        <div className="min-h-[120px] flex-1 overflow-y-auto px-3 py-1.5">
          {cartLines.length === 0 ? (
            <div className="px-2.5 py-10 text-center text-[12.5px] text-[#9a9e93]">
              No items yet.
              <br />
              Tap products to add them.
            </div>
          ) : (
            cartLines.map((l) => (
              <div key={l.productId} className="flex items-center gap-2.5 border-b border-[#f4f2ea] py-2.5">
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
                <div className="w-[52px] text-right font-mono text-[13px] font-semibold">{l.lineTotal}</div>
              </div>
            ))
          )}
        </div>
        <div className="border-t border-border px-4 py-3.5">
          <div className="mb-1.5 flex justify-between text-[12.5px] text-[#6b6f66]">
            <span>Items</span>
            <span className="font-mono">{cartCount}</span>
          </div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="font-semibold">Total tokens</span>
            <span className="font-mono text-xl font-semibold text-primary">{cartTotal}</span>
          </div>
          <div
            className="mb-3 flex justify-between text-[12px]"
            style={{ color: balanceAfter !== null && balanceAfter < 0 ? "var(--destructive)" : "#6b6f66" }}
          >
            <span>Balance after</span>
            <span className="font-mono">{balanceAfter === null ? "—" : balanceAfter}</span>
          </div>
          {error && <p className="mb-3 text-[12.5px] text-destructive">{error}</p>}
          <button
            type="button"
            onClick={handleCheckout}
            disabled={!canCheckout || isCheckingOut}
            className="w-full rounded-[10px] py-3.5 text-[14px] font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#e7e4db] disabled:text-[#9a9e93]"
            style={canCheckout && !isCheckingOut ? { background: "var(--primary)" } : undefined}
          >
            {isCheckingOut
              ? "Dispensing…"
              : !selectedMember
                ? "Select a member"
                : cartCount === 0
                  ? "Add products"
                  : (balanceAfter ?? -1) < 0
                    ? "Insufficient balance"
                    : `Confirm dispense · ${cartTotal} tokens`}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create the page**

Create `src/app/[clubSlug]/dispense/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import { getProducts } from "@/lib/products";
import { listMembers } from "@/lib/members";
import { DispensingHeader } from "./dispensing-header";
import { DispensingPanel } from "./dispensing-panel";

export default async function DispensePage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const supabase = await createClient();
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();

  const [products, members] = await Promise.all([
    getProducts(supabase, access.clubId),
    listMembers(supabase, access.clubId),
  ]);

  return (
    <>
      <DispensingHeader />
      <DispensingPanel clubId={access.clubId} products={products} members={members} />
    </>
  );
}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Build**

Run: `pnpm build`
Expected: succeeds, route table includes `/[clubSlug]/dispense`.

- [ ] **Step 7: Manual smoke test**

Use an isolated throwaway test club + throwaway admin user via the service-role key (`createAdminClient` from `src/lib/supabase/admin.ts`) — NOT the real shared `demo` club. Sign in, load `/dispense`, and confirm: (a) member search filters correctly by typed text and selecting a result shows their real token balance; (b) tapping products builds the cart with the correct running token total and per-line quantity controls work; (c) completing a dispense actually decrements stock (query `product_stock` directly) AND the member's `token_balance` (query directly) by the exact right amounts — do not just trust the success toast; (d) the product grid's displayed stock figures update after checkout without a page reload. Delete the throwaway club/user and any created rows immediately after, and verify deletion via a follow-up query.

- [ ] **Step 8: Commit**

```bash
git add src/app/\[clubSlug\]/dispense/page.tsx src/app/\[clubSlug\]/dispense/dispensing-header.tsx src/app/\[clubSlug\]/dispense/dispensing-panel.tsx src/app/\[clubSlug\]/dispense/actions.ts
git commit -m "Build the Dispensing screen (member search, product grid, cart, checkout)"
```

---

## Self-Review Notes

- **Spec coverage:** schema (Task 1), the atomic checkout function including the stock-sufficiency guard the mock never had (Task 2), the data layer + full correctness/atomicity test matrix (Task 3), the real searchable member picker replacing the mock's hardcoded chips + product grid + cart + checkout UX (Task 4) — every section of `docs/superpowers/specs/2026-07-30-dispensing-design.md` maps to a task.
- **Type consistency checked:** `CartItem`/`DispenseOrderItem`/`DispenseOrder` field names match exactly between Task 3's implementation, Task 3's tests, and Task 4's consumption (`order.tokenTotal`, `order.items`, `result.order.tokenTotal`). `Product`/`MemberListRow` field names independently confirmed against the actual current library files before writing this plan — no drift.
- **No placeholders:** every step has complete, runnable code.
- **Atomicity is tested, not just asserted**: Task 3's last test proves a two-line order's first (valid) line is NOT partially applied when the second line fails — the strongest form of this project's "verify, don't trust" testing convention applied to a genuinely multi-step transaction.
