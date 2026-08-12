# Custom Product Categories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed 5-category set with a real per-club `product_categories` table admins can rename/delete/add to, migrating Cottonmouth's live product data with zero loss along the way.

**Architecture:** New table + RLS (Task 1), then a staged live-data migration that backfills existing products and seeds every future club (Task 2), then the data layer + a shared-test-fixture fix + tests (Task 3), then the UI — a categories management panel on Products, plus category-aware selects/filters in Products and Dispensing (Task 4). Schema and the destructive backfill/drop-column migration each get their own dedicated review gate, matching this project's established discipline for live-data-touching changes.

**Tech Stack:** Next.js App Router, TypeScript, Supabase JS client, PL/pgSQL, Vitest.

## Global Constraints

- Reuse `src/lib/auth/require-role.ts`'s `assertClubAdmin`, `src/lib/supabase/server.ts`, `src/lib/toast-context.tsx`'s `useToast` exactly as they exist — do not modify any of them.
- This plan explicitly modifies `src/lib/products.ts`, `src/lib/dashboard.ts`, `src/lib/invites.ts`, `src/app/[clubSlug]/products/products-table.tsx`, `src/app/[clubSlug]/products/actions.ts`, `src/app/[clubSlug]/products/page.tsx`, `src/app/[clubSlug]/dispense/dispensing-panel.tsx`, `src/app/[clubSlug]/dispense/page.tsx`, and `tests/rls/fixtures.ts` — unlike most prior plans' "reuse exactly as-is" instruction, these are the feature's whole point.
- No PostgREST relation embedding anywhere — every category-name resolution is a separate batched query + in-memory map.
- No shadcn/`@base-ui/react` components — hand-rolled Tailwind, matching every prior screen.
- Every labeled form field needs `htmlFor`/`id` pairing.
- Migration files follow the existing `YYYYMMDDHHMMSS_description.sql` naming, applied via `supabase db push --linked` against the live linked project (ref `inlseklfbptgjketdnpe`) — **this project has real customer data (Cottonmouth) in it now.** Task 2's migration is destructive (drops `products.category`) and must be preceded by an explicit zero-unmatched-rows verification, not assumed.
- pnpm exclusively, Node via `.nvmrc` (run `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use` before any command — fall back to `node_modules/.bin/tsc`/`node_modules/.bin/next`/`node_modules/.bin/vitest` directly if this environment's pnpm/corepack shim still breaks).
- Commit messages plain, imperative. Work on branch `master` directly (standing consent from all prior phases).
- `Product`/`ProductInput` (`src/lib/products.ts`), `assertClubAdmin` (`src/lib/auth/require-role.ts`), and `SeededClub`/`SeededData` (`tests/rls/fixtures.ts`) confirmed against the actual current files — no drift.

---

### Task 1: Migration — `product_categories` schema + RLS

**Files:**
- Create: `supabase/migrations/20260812170000_product_categories_schema.sql`

**Interfaces:**
- Produces: the `product_categories` table — consumed by Task 2's backfill and Task 3's data layer.

No application code in this task — pure schema, verified against the live project directly. The `products` table itself is untouched by this task.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260812170000_product_categories_schema.sql`:

```sql
create table product_categories (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (club_id, name)
);
create index product_categories_club_id_idx on product_categories(club_id);

alter table product_categories enable row level security;

create policy product_categories_select on product_categories for select to authenticated
  using (club_id in (select my_club_ids()));

create policy product_categories_insert on product_categories for insert to authenticated
  with check (
    club_id in (select my_club_ids())
    and exists (select 1 from club_users where user_id = auth.uid() and club_id = product_categories.club_id and role = 'admin')
  );

create policy product_categories_update on product_categories for update to authenticated
  using (
    club_id in (select my_club_ids())
    and exists (select 1 from club_users where user_id = auth.uid() and club_id = product_categories.club_id and role = 'admin')
  )
  with check (
    club_id in (select my_club_ids())
    and exists (select 1 from club_users where user_id = auth.uid() and club_id = product_categories.club_id and role = 'admin')
  );

create policy product_categories_delete on product_categories for delete to authenticated
  using (
    club_id in (select my_club_ids())
    and exists (select 1 from club_users where user_id = auth.uid() and club_id = product_categories.club_id and role = 'admin')
  );
```

- [ ] **Step 2: Apply the migration**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use && supabase db push --linked`
Expected: lists the new migration, applies it, ends with `Finished supabase db push.`

- [ ] **Step 3: Verify nothing is left pending**

Run: `supabase db push --linked --dry-run`
Expected: no pending migrations listed.

- [ ] **Step 4: Verify schema and RLS against the live project**

```sql
select column_name, data_type, is_nullable from information_schema.columns
where table_name = 'product_categories' order by ordinal_position;
```
Expected: `id, club_id, name, created_at` — `club_id`, `name`, `created_at` `NOT NULL`.

```sql
select indexname, indexdef from pg_indexes where tablename = 'product_categories';
```
Expected: `product_categories_club_id_idx` and a unique index/constraint covering `(club_id, name)`.

```sql
select policyname, cmd from pg_policies
where schemaname = 'public' and tablename = 'product_categories' order by cmd;
```
Expected: exactly 4 rows — SELECT, INSERT, UPDATE, DELETE.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260812170000_product_categories_schema.sql
git commit -m "Add product_categories table with role-aware RLS"
```

---

### Task 2: Live-data migration — backfill existing products + seed future clubs

**Files:**
- Create: `supabase/migrations/20260812170100_product_categories_backfill.sql`
- Modify: `src/lib/invites.ts`

**Interfaces:**
- Consumes: Task 1's `product_categories` table.
- Produces: `products.category_id uuid not null references product_categories(id) on delete restrict` (the old `products.category` text column is gone). `createClubAndInviteAdmin` now also seeds 5 default categories for every newly onboarded club.

This is the highest-risk task in this plan — it touches Cottonmouth's real, currently-in-use `products` rows and ends by dropping a column. Follow every verification step; do not skip the zero-unmatched-rows check.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260812170100_product_categories_backfill.sql`:

```sql
-- Seed the 5 existing default categories for every club that already
-- exists (Cottonmouth included). on conflict guards re-running safety.
insert into product_categories (club_id, name)
select c.id, cat.name
from clubs c
cross join (values ('Flower'), ('Pre-rolls'), ('Edibles'), ('Concentrate'), ('Accessory')) as cat(name)
on conflict (club_id, name) do nothing;

-- Nullable at first -- it must be backfilled before it can be required.
alter table products add column category_id uuid references product_categories(id) on delete restrict;

-- Match every existing product to the category row with the same name,
-- within the same club. Guaranteed 1:1: the old CHECK constraint only
-- ever allowed the 5 exact names just seeded above.
update products p
set category_id = pc.id
from product_categories pc
where pc.club_id = p.club_id and pc.name = p.category;
```

- [ ] **Step 2: Apply the migration**

Run: `supabase db push --linked`
Expected: applies cleanly.

- [ ] **Step 3: Verify nothing is left pending**

Run: `supabase db push --linked --dry-run`
Expected: no pending migrations listed.

- [ ] **Step 4: Verify ZERO unmatched rows before proceeding — this is the gate that must pass before Step 5**

```sql
select count(*) from products where category_id is null;
```
Expected: `0`. **If this is not `0`, STOP.** Do not proceed to Step 5. Investigate which product rows failed to match (query `select id, club_id, category from products where category_id is null` to see them) — this would mean a product's `category` value didn't exactly match one of the 5 seeded names for its club, which should be structurally impossible given the prior CHECK constraint, so a non-zero count here means something upstream is wrong and needs to be understood before any further schema change.

- [ ] **Step 5: Make `category_id` required and drop the old column**

Create a second migration file `supabase/migrations/20260812170200_product_categories_finalize.sql` (kept separate from Step 1's file so Step 4's verification gate sits between two distinct, individually-committed migrations, not buried mid-file):

```sql
alter table products alter column category_id set not null;
alter table products drop column category;
```

Apply it the same way:

Run: `supabase db push --linked`
Expected: applies cleanly.

Run: `supabase db push --linked --dry-run`
Expected: no pending migrations listed.

- [ ] **Step 6: Verify the final shape**

```sql
select column_name, is_nullable from information_schema.columns
where table_name = 'products' and column_name in ('category', 'category_id');
```
Expected: exactly ONE row (`category_id`, `is_nullable = NO`) — `category` no longer exists.

```sql
select count(*) as total, count(distinct category_id) as distinct_categories_used from products;
```
Expected: `total` matches the product count you'd expect for the live project (sanity check — no rows were lost); `distinct_categories_used` is between 1 and 5 for existing clubs (confirms real, varied category assignment, not everything collapsed onto one row by mistake).

- [ ] **Step 7: Seed default categories for future clubs in `src/lib/invites.ts`**

In `createClubAndInviteAdmin`, insert this block immediately after the existing `if (clubError) throw clubError;` line (before the `try { ... }` block that invites the admin):

```ts
  const { error: categoriesError } = await admin.from("product_categories").insert(
    ["Flower", "Pre-rolls", "Edibles", "Concentrate", "Accessory"].map((name) => ({ club_id: club.id, name })),
  );
  if (categoriesError) {
    await admin.from("clubs").delete().eq("id", club.id);
    throw categoriesError;
  }
```

This mirrors the function's existing rollback-on-failure pattern (visible in the `catch` block a few lines below) — if category seeding fails, the club row is deleted rather than left in a half-onboarded state.

- [ ] **Step 8: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no output, exit 0. (This will show pre-existing errors in files this task doesn't touch yet, like `products.ts` still referencing the old `category` column shape — Task 3 fixes those. If `invites.ts` itself has no new errors from this task's change, that's what this step confirms.)

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/20260812170100_product_categories_backfill.sql supabase/migrations/20260812170200_product_categories_finalize.sql src/lib/invites.ts
git commit -m "Backfill products to product_categories and seed defaults for new clubs"
```

---

### Task 3: Data layer + shared test fixture fix + tests

**Files:**
- Create: `src/lib/categories.ts`
- Modify: `src/lib/products.ts`
- Modify: `src/lib/dashboard.ts`
- Modify: `tests/rls/fixtures.ts`
- Modify: `tests/products.test.ts`
- Test: `tests/categories.test.ts`

**Interfaces:**
- Consumes: Task 1/2's schema.
- Produces: `ProductCategoryRow` type, `getCategories`/`createCategory`/`renameCategory`/`deleteCategory` (`src/lib/categories.ts`) — consumed by Task 4's UI. `Product.categoryId`/`Product.categoryName`, `ProductInput.categoryId` (`src/lib/products.ts`) — consumed by Task 4's UI. `SeededClub.categoryId` (`tests/rls/fixtures.ts`) — available to any future test file that needs a valid category id for the fixture club.

- [ ] **Step 1: Write `src/lib/categories.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertClubAdmin } from "@/lib/auth/require-role";

export type ProductCategoryRow = { id: string; name: string };

export async function getCategories(supabase: SupabaseClient, clubId: string): Promise<ProductCategoryRow[]> {
  const { data, error } = await supabase
    .from("product_categories")
    .select("id, name")
    .eq("club_id", clubId)
    .order("name", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => ({ id: row.id as string, name: row.name as string }));
}

export async function createCategory(
  supabase: SupabaseClient,
  clubId: string,
  name: string,
): Promise<ProductCategoryRow> {
  await assertClubAdmin(supabase, clubId);
  const { data, error } = await supabase
    .from("product_categories")
    .insert({ club_id: clubId, name })
    .select("id, name")
    .single();
  if (error) throw error;
  return { id: data.id as string, name: data.name as string };
}

export async function renameCategory(
  supabase: SupabaseClient,
  clubId: string,
  categoryId: string,
  name: string,
): Promise<ProductCategoryRow> {
  await assertClubAdmin(supabase, clubId);
  const { data, error } = await supabase
    .from("product_categories")
    .update({ name })
    .eq("id", categoryId)
    .eq("club_id", clubId)
    .select("id, name")
    .single();
  if (error) throw error;
  return { id: data.id as string, name: data.name as string };
}

export async function deleteCategory(supabase: SupabaseClient, clubId: string, categoryId: string): Promise<void> {
  await assertClubAdmin(supabase, clubId);

  const { count, error: countError } = await supabase
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("club_id", clubId)
    .eq("category_id", categoryId);
  if (countError) throw countError;
  if ((count ?? 0) > 0) {
    throw new Error(`Cannot delete: ${count} product(s) still use this category`);
  }

  const { error } = await supabase.from("product_categories").delete().eq("id", categoryId).eq("club_id", clubId);
  if (error) throw error;
}
```

- [ ] **Step 2: Update `src/lib/products.ts`**

Remove the `ProductCategory` type entirely (delete this line):

```ts
export type ProductCategory = "Flower" | "Pre-rolls" | "Edibles" | "Concentrate" | "Accessory";
```

Change `Product`'s `category` field to two fields:

```ts
export type Product = {
  id: string;
  name: string;
  categoryId: string;
  categoryName: string;
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

Change `ProductRow`'s `category` field to `category_id`:

```ts
type ProductRow = {
  id: string;
  name: string;
  category_id: string;
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

Change `mapProduct` to take a `categoryName` parameter (same pattern as the existing `stock` parameter — resolved separately, never embedded):

```ts
function mapProduct(row: ProductRow, stock: number, categoryName: string): Product {
  return {
    id: row.id,
    name: row.name,
    categoryId: row.category_id,
    categoryName,
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

Change `PRODUCT_COLUMNS`:

```ts
const PRODUCT_COLUMNS = "id, name, category_id, unit, token_price, sell_price, cost, description, flags, price_tiers, active";
```

Change `getProducts` to resolve category names (insert this block between the existing stock-lookup block and the final `return rows.map(...)` line, then change that final line):

```ts
export async function getProducts(supabase: SupabaseClient, clubId: string): Promise<Product[]> {
  const { data: products, error: productsError } = await supabase
    .from("products")
    .select(PRODUCT_COLUMNS)
    .eq("club_id", clubId)
    .order("name", { ascending: true });
  if (productsError) throw productsError;

  const rows = products ?? [];
  if (rows.length === 0) return [];

  const { data: stockRows, error: stockError } = await supabase
    .from("product_stock")
    .select("product_id, stock")
    .eq("club_id", clubId)
    .in(
      "product_id",
      rows.map((p) => p.id),
    );
  if (stockError) throw stockError;

  const stockByProductId = new Map(
    (stockRows ?? []).map((r) => [r.product_id as string, r.stock as number]),
  );

  const categoryIds = [...new Set(rows.map((r) => r.category_id as string))];
  const { data: categories, error: categoriesError } = await supabase
    .from("product_categories")
    .select("id, name")
    .in("id", categoryIds);
  if (categoriesError) throw categoriesError;
  const categoryNameById = new Map((categories ?? []).map((c) => [c.id as string, c.name as string]));

  return rows.map((row) =>
    mapProduct(
      row as ProductRow,
      stockByProductId.get(row.id as string) ?? 0,
      categoryNameById.get(row.category_id as string) ?? "—",
    ),
  );
}
```

Change `ProductInput`:

```ts
export type ProductInput = {
  name: string;
  categoryId: string;
  unit: string;
  tokenPrice: number;
  sellPrice: number;
  cost?: number | null;
  description?: string | null;
  flags: string[];
  priceTiers: PriceTier[];
};
```

Change `createProduct` — the insert payload's `category: input.category,` becomes `category_id: input.categoryId,`, and the return needs a category-name lookup (a single-row query, since only one product's category is being resolved here, not a batch):

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
      category_id: input.categoryId,
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

  const { data: category, error: categoryError } = await supabase
    .from("product_categories")
    .select("name")
    .eq("id", input.categoryId)
    .single();
  if (categoryError) throw categoryError;

  return mapProduct(data as ProductRow, 0, category.name as string);
}
```

Change `updateProduct` the same way:

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
      category_id: input.categoryId,
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

  const { data: stockRow } = await supabase
    .from("product_stock")
    .select("stock")
    .eq("product_id", productId)
    .eq("club_id", clubId)
    .maybeSingle();

  const { data: category, error: categoryError } = await supabase
    .from("product_categories")
    .select("name")
    .eq("id", input.categoryId)
    .single();
  if (categoryError) throw categoryError;

  return mapProduct(data as ProductRow, stockRow?.stock ?? 0, category.name as string);
}
```

`hasProductHistory` and `deleteOrDeactivateProduct` are unchanged — neither references `category`.

- [ ] **Step 3: Update `src/lib/dashboard.ts`'s `getLowStockAlerts`**

Replace the whole function body:

```ts
export async function getLowStockAlerts(
  supabase: SupabaseClient,
  clubId: string,
  limit: number,
): Promise<LowStockAlert[]> {
  const { data: products, error: productsError } = await supabase
    .from("products")
    .select("id, name, category_id, unit")
    .eq("club_id", clubId)
    .eq("active", true);
  if (productsError) throw productsError;
  if (!products || products.length === 0) return [];

  const { data: stockRows, error: stockError } = await supabase
    .from("product_stock")
    .select("product_id, stock")
    .eq("club_id", clubId)
    .in(
      "product_id",
      products.map((p) => p.id),
    )
    .lte("stock", LOW_STOCK_THRESHOLD);
  if (stockError) throw stockError;

  const stockByProductId = new Map((stockRows ?? []).map((r) => [r.product_id as string, r.stock as number]));

  const categoryIds = [...new Set(products.map((p) => p.category_id as string))];
  const { data: categories, error: categoriesError } = await supabase
    .from("product_categories")
    .select("id, name")
    .in("id", categoryIds);
  if (categoriesError) throw categoriesError;
  const categoryNameById = new Map((categories ?? []).map((c) => [c.id as string, c.name as string]));

  return products
    .filter((p) => stockByProductId.has(p.id))
    .map((p) => ({
      productId: p.id as string,
      name: p.name as string,
      category: categoryNameById.get(p.category_id as string) ?? "—",
      unit: p.unit as string,
      stock: stockByProductId.get(p.id)!,
    }))
    .sort((a, b) => a.stock - b.stock)
    .slice(0, limit);
}
```

`LowStockAlert`'s `category: string` field is unchanged — it's still a display name, just resolved differently now.

- [ ] **Step 4: Fix the shared test fixture — `tests/rls/fixtures.ts`**

Add `categoryId: string;` to the `SeededClub` type (after `signaturePath: string;`):

```ts
export type SeededClub = {
  clubId: string;
  slug: string;
  adminEmail: string;
  adminPassword: string;
  adminUserId: string;
  memberId: string;
  productId: string;
  inventoryMoveId: string;
  donationId: string;
  contractTemplateId: string;
  signedContractId: string;
  signaturePath: string;
  categoryId: string;
};
```

In `seedClub`, insert a category row immediately before the existing product insert, and reference it:

```ts
  const { data: category, error: categoryError } = await admin
    .from("product_categories")
    .insert({ club_id: club.id, name: "Flower" })
    .select()
    .single();
  if (categoryError) throw categoryError;

  const { data: product, error: productError } = await admin
    .from("products")
    .insert({
      club_id: club.id,
      name: "Test Product",
      category_id: category.id,
      unit: "per 1g",
      token_price: 45,
      sell_price: 60,
    })
    .select()
    .single();
  if (productError) throw productError;
```

At the end of `seedClub`, add `categoryId: category.id,` to the returned object (alongside the existing `signaturePath: signaturePath,` line — check the actual current return statement's field list and add this one field to it without altering any other field).

No changes are needed to `cleanupTenants` — `product_categories.club_id` has `on delete cascade` from `clubs` (Task 1), so the seeded category row is removed automatically when the club is deleted, same as every other per-club fixture row.

- [ ] **Step 5: Update `tests/products.test.ts`**

Every `category: "Flower"` / `category: "Edibles"` / `category: "Accessory"` line inside a `ProductInput`-shaped object (i.e., every `createProduct(...)`/`updateProduct(...)` call in this file) becomes `categoryId: data.clubA.categoryId,` — no test in this file asserts on the specific category text (confirmed by reading the file: assertions check `name`/`active`/`stock`/`cost`/`flags`/`priceTiers`, never `category`), so this is a uniform substitution regardless of which of the three names a given line used. For example, this:

```ts
    const created = await createProduct(clubAClient, data.clubA.clubId, {
      name: "No Moves Product",
      category: "Flower",
      unit: "per 1g",
      tokenPrice: 40,
      sellPrice: 50,
      flags: [],
      priceTiers: [],
    });
```

becomes:

```ts
    const created = await createProduct(clubAClient, data.clubA.clubId, {
      name: "No Moves Product",
      categoryId: data.clubA.categoryId,
      unit: "per 1g",
      tokenPrice: 40,
      sellPrice: 50,
      flags: [],
      priceTiers: [],
    });
```

Apply the identical `category: "..."` → `categoryId: data.clubA.categoryId,` substitution to every remaining occurrence of this pattern in the file (there are 13 such call sites across the `getProducts`, `createProduct`, `updateProduct`, `role-based access`, and `price tiers` `describe` blocks).

Two occurrences are different — direct raw-table inserts (not `ProductInput`-shaped, snake_case, inside the `"RLS itself rejects a direct staff INSERT/UPDATE/DELETE on products..."` test) — these use `category: "Flower"` as a raw column value and become `category_id: data.clubA.categoryId,` (snake_case, matching the rest of that raw insert's field names):

```ts
    const { error: insertError } = await staffClient.from("products").insert({
      club_id: data.clubA.clubId,
      name: "Direct REST Bypass Attempt",
      category_id: data.clubA.categoryId,
      unit: "per 1g",
      token_price: 10,
      sell_price: 15,
    });
```

and:

```ts
    const { data: adminProduct, error: adminInsertError } = await clubAClient
      .from("products")
      .insert({
        club_id: data.clubA.clubId,
        name: "Direct Admin Insert",
        category_id: data.clubA.categoryId,
        unit: "per 1g",
        token_price: 10,
        sell_price: 15,
      })
      .select()
      .single();
```

- [ ] **Step 6: Write `tests/categories.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedTenants, cleanupTenants, signInAs, type SeededData } from "./rls/fixtures";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCategories, createCategory, renameCategory, deleteCategory } from "@/lib/categories";
import { getProducts, createProduct } from "@/lib/products";

let data: SeededData;
let clubAClient: SupabaseClient;
let clubBClient: SupabaseClient;
let staffClient: SupabaseClient;
let staffUserId: string;
const STAFF_PASSWORD = "Test-Password-123!";
const cleanupCategoryIds: string[] = [];
const cleanupProductIds: string[] = [];

beforeAll(async () => {
  data = await seedTenants();
  clubAClient = await signInAs(data.clubA.adminEmail, data.clubA.adminPassword);
  clubBClient = await signInAs(data.clubB.adminEmail, data.clubB.adminPassword);

  const admin = createAdminClient();
  const staffEmail = `categories-staff-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const { data: staffAuth, error: staffAuthError } = await admin.auth.admin.createUser({
    email: staffEmail,
    password: STAFF_PASSWORD,
    email_confirm: true,
  });
  if (staffAuthError) throw staffAuthError;
  staffUserId = staffAuth.user.id;

  const { error: staffMembershipError } = await admin.from("club_users").insert({
    club_id: data.clubA.clubId,
    user_id: staffUserId,
    role: "staff",
  });
  if (staffMembershipError) throw staffMembershipError;

  staffClient = await signInAs(staffEmail, STAFF_PASSWORD);
}, 30000);

afterAll(async () => {
  const admin = createAdminClient();
  if (cleanupProductIds.length > 0) {
    await admin.from("products").delete().in("id", cleanupProductIds);
  }
  if (cleanupCategoryIds.length > 0) {
    await admin.from("product_categories").delete().in("id", cleanupCategoryIds);
  }
  if (staffUserId) {
    await admin.auth.admin.deleteUser(staffUserId);
  }
  if (data) {
    await cleanupTenants(data);
  }
}, 30000);

describe("getCategories", () => {
  it("returns only the caller's club's categories, not club B's", async () => {
    const categories = await getCategories(clubAClient, data.clubA.clubId);
    const ids = categories.map((c) => c.id);
    expect(ids).toContain(data.clubA.categoryId);

    const clubBCategories = await getCategories(clubBClient, data.clubB.clubId);
    expect(clubBCategories.map((c) => c.id)).not.toContain(data.clubA.categoryId);
  });
});

describe("createCategory", () => {
  it("rejects a staff-role user, admin succeeds", async () => {
    await expect(createCategory(staffClient, data.clubA.clubId, "Staff Attempt")).rejects.toThrow(
      "Admin access required",
    );

    const category = await createCategory(clubAClient, data.clubA.clubId, "Merch");
    cleanupCategoryIds.push(category.id);
    expect(category.name).toBe("Merch");
  });
});

describe("renameCategory", () => {
  it("updates the name, and getProducts reflects it immediately for any product referencing it", async () => {
    const category = await createCategory(clubAClient, data.clubA.clubId, "Original Name");
    cleanupCategoryIds.push(category.id);

    const product = await createProduct(clubAClient, data.clubA.clubId, {
      name: "Renamed Category Product",
      categoryId: category.id,
      unit: "per 1g",
      tokenPrice: 10,
      sellPrice: 15,
      flags: [],
      priceTiers: [],
    });
    cleanupProductIds.push(product.id);

    await renameCategory(clubAClient, data.clubA.clubId, category.id, "Renamed");

    const products = await getProducts(clubAClient, data.clubA.clubId);
    const found = products.find((p) => p.id === product.id);
    expect(found).toBeDefined();
    expect(found!.categoryName).toBe("Renamed");
  });
});

describe("deleteCategory", () => {
  it("succeeds when unused, rejects when a product references it, and rejects staff", async () => {
    const unused = await createCategory(clubAClient, data.clubA.clubId, "Unused Category");
    await deleteCategory(clubAClient, data.clubA.clubId, unused.id);
    const remaining = await getCategories(clubAClient, data.clubA.clubId);
    expect(remaining.map((c) => c.id)).not.toContain(unused.id);

    const inUse = await createCategory(clubAClient, data.clubA.clubId, "In Use Category");
    cleanupCategoryIds.push(inUse.id);
    const product = await createProduct(clubAClient, data.clubA.clubId, {
      name: "Blocks Category Delete",
      categoryId: inUse.id,
      unit: "per 1g",
      tokenPrice: 10,
      sellPrice: 15,
      flags: [],
      priceTiers: [],
    });
    cleanupProductIds.push(product.id);

    await expect(deleteCategory(clubAClient, data.clubA.clubId, inUse.id)).rejects.toThrow(
      "1 product(s) still use this category",
    );

    await expect(deleteCategory(staffClient, data.clubA.clubId, inUse.id)).rejects.toThrow(
      "Admin access required",
    );
  });
});
```

- [ ] **Step 7: Run the FULL test suite (not just files this feature touches)**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use && node_modules/.bin/vitest run`
Expected: all tests across the whole project pass. This is the specific check the spec calls out — `seedClub()`'s change touches nearly every test file's fixture data, so a full run (not a filtered one) is this task's real verification, not an optional extra.

- [ ] **Step 8: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no output, exit 0. (This will still show errors in `products-table.tsx`/`dispensing-panel.tsx` — Task 4 fixes those. This step confirms every file THIS task touches — `categories.ts`, `products.ts`, `dashboard.ts`, `fixtures.ts`, `products.test.ts`, `categories.test.ts` — is itself clean; a full zero-error `tsc` run only happens after Task 4.)

- [ ] **Step 9: Commit**

```bash
git add src/lib/categories.ts src/lib/products.ts src/lib/dashboard.ts tests/rls/fixtures.ts tests/products.test.ts tests/categories.test.ts
git commit -m "Add category data layer, fix shared test fixture, add category tests"
```

---

### Task 4: UI — categories management panel + category-aware selects and filters

**Files:**
- Create: `src/app/[clubSlug]/products/categories-panel.tsx`
- Modify: `src/app/[clubSlug]/products/actions.ts`
- Modify: `src/app/[clubSlug]/products/products-table.tsx`
- Modify: `src/app/[clubSlug]/products/page.tsx`
- Modify: `src/app/[clubSlug]/dispense/dispensing-panel.tsx`
- Modify: `src/app/[clubSlug]/dispense/page.tsx`

**Interfaces:**
- Consumes: Task 3's `ProductCategoryRow` type and `getCategories`/`createCategory`/`renameCategory`/`deleteCategory` from `@/lib/categories`, and `Product.categoryId`/`categoryName`, `ProductInput.categoryId` from `@/lib/products`.

- [ ] **Step 1: Add category server actions to `src/app/[clubSlug]/products/actions.ts`**

Add this import (alongside the existing `@/lib/products` import):

```ts
import { createCategory, renameCategory, deleteCategory, type ProductCategoryRow } from "@/lib/categories";
```

Add these three functions at the end of the file:

```ts
export async function createCategoryAction(
  clubId: string,
  name: string,
): Promise<{ ok: true; category: ProductCategoryRow } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const category = await createCategory(supabase, clubId, name);
    return { ok: true, category };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to add category" };
  }
}

export async function renameCategoryAction(
  clubId: string,
  categoryId: string,
  name: string,
): Promise<{ ok: true; category: ProductCategoryRow } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const category = await renameCategory(supabase, clubId, categoryId, name);
    return { ok: true, category };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to rename category" };
  }
}

export async function deleteCategoryAction(
  clubId: string,
  categoryId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    await deleteCategory(supabase, clubId, categoryId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to delete category" };
  }
}
```

- [ ] **Step 2: Write `src/app/[clubSlug]/products/categories-panel.tsx`**

```tsx
"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/lib/toast-context";
import { createCategoryAction, renameCategoryAction, deleteCategoryAction } from "./actions";
import type { ProductCategoryRow } from "@/lib/categories";

export function CategoriesPanel({
  clubId,
  categories: initialCategories,
}: {
  clubId: string;
  categories: ProductCategoryRow[];
}) {
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [categories, setCategories] = useState(initialCategories);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleAdd() {
    setError(null);
    if (!newName.trim()) {
      setError("Enter a category name");
      return;
    }
    startTransition(async () => {
      const result = await createCategoryAction(clubId, newName.trim());
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCategories((prev) => [...prev, result.category].sort((a, b) => a.name.localeCompare(b.name)));
      setNewName("");
      showToast("Category added");
    });
  }

  function startRename(category: ProductCategoryRow) {
    setEditingId(category.id);
    setEditingName(category.name);
    setError(null);
  }

  function handleRename(categoryId: string) {
    setError(null);
    if (!editingName.trim()) {
      setError("Enter a category name");
      return;
    }
    startTransition(async () => {
      const result = await renameCategoryAction(clubId, categoryId, editingName.trim());
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCategories((prev) =>
        prev.map((c) => (c.id === categoryId ? result.category : c)).sort((a, b) => a.name.localeCompare(b.name)),
      );
      setEditingId(null);
      showToast("Category renamed");
    });
  }

  function handleDelete(categoryId: string) {
    setError(null);
    startTransition(async () => {
      const result = await deleteCategoryAction(clubId, categoryId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCategories((prev) => prev.filter((c) => c.id !== categoryId));
      showToast("Category deleted");
    });
  }

  return (
    <div className="mb-3.5 rounded-card border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center justify-between px-[18px] py-3 text-left"
      >
        <span className="font-heading text-[14px] font-semibold">Manage categories</span>
        <span className="text-[12px] text-[#9a9e93]">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="border-t border-[#f0eee6] px-[18px] py-3.5">
          {categories.length === 0 ? (
            <p className="mb-3 text-[12.5px] text-[#9a9e93]">No categories yet — add one below.</p>
          ) : (
            <div className="mb-3 flex flex-col gap-2">
              {categories.map((c) => (
                <div key={c.id} className="flex items-center gap-2">
                  {editingId === c.id ? (
                    <>
                      <label htmlFor={`categoryRename-${c.id}`} className="sr-only">
                        Category name
                      </label>
                      <input
                        id={`categoryRename-${c.id}`}
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        className="flex-1 rounded-[8px] border border-input px-2.5 py-2 text-[12.5px]"
                      />
                      <button
                        type="button"
                        onClick={() => handleRename(c.id)}
                        disabled={isPending}
                        className="rounded-[6px] border border-input bg-muted px-2 py-1 text-[11px] font-medium text-[#6b6f66]"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="rounded-[6px] border border-input bg-muted px-2 py-1 text-[11px] font-medium text-[#6b6f66]"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 text-[13px]">{c.name}</span>
                      <button
                        type="button"
                        onClick={() => startRename(c)}
                        title="Rename"
                        className="h-[28px] w-[28px] rounded-[7px] border border-input text-[12px] text-[#6b6f66]"
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(c.id)}
                        disabled={isPending}
                        title="Delete"
                        className="h-[28px] w-[28px] rounded-[7px] border border-input text-[13px] text-destructive"
                      >
                        🗑
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
          {error && <p className="mb-2 text-[12px] text-destructive">{error}</p>}
          <div className="flex items-center gap-2">
            <label htmlFor="newCategoryName" className="sr-only">
              New category name
            </label>
            <input
              id="newCategoryName"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New category name"
              className="flex-1 rounded-[8px] border border-input px-2.5 py-2 text-[12.5px]"
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={isPending}
              className="rounded-[8px] border border-input bg-muted px-3 py-2 text-[12.5px] font-medium text-[#6b6f66]"
            >
              + Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Update `src/app/[clubSlug]/products/products-table.tsx`**

Change the import line:

```ts
import type { Product } from "@/lib/products";
import type { ProductCategoryRow } from "@/lib/categories";
```

Delete this line entirely (the hardcoded category list):

```ts
const CATEGORIES: ProductCategory[] = ["Flower", "Pre-rolls", "Edibles", "Concentrate", "Accessory"];
```

Change `ProductDraft`'s `category` field:

```ts
type ProductDraft = {
  name: string;
  categoryId: string;
  unit: string;
  tokenPrice: string;
  sellPrice: string;
  cost: string;
  description: string;
  flags: string[];
  priceTiers: PriceTierDraft[];
};
```

Change `EMPTY_DRAFT`'s `category` field:

```ts
const EMPTY_DRAFT: ProductDraft = {
  name: "",
  categoryId: "",
  unit: "",
  tokenPrice: "",
  sellPrice: "",
  cost: "",
  description: "",
  flags: [],
  priceTiers: [],
};
```

Change `draftFromProduct`'s `category` line:

```ts
function draftFromProduct(product: Product): ProductDraft {
  return {
    name: product.name,
    categoryId: product.categoryId,
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

Change the component signature to accept `categories`:

```ts
export function ProductsTable({
  clubId,
  products: initialProducts,
  categories,
}: {
  clubId: string;
  products: Product[];
  categories: ProductCategoryRow[];
}) {
```

Change `openCreate` to default the draft's category to the first available one:

```ts
  function openCreate() {
    setDraft({ ...EMPTY_DRAFT, categoryId: categories[0]?.id ?? "" });
    setModalMode("create");
    setEditingId(null);
    setSaveError(null);
    setModalOpen(true);
  }
```

Change `handleSave`'s validation and payload:

```ts
  function handleSave() {
    setSaveError(null);
    if (!draft.name.trim()) {
      setSaveError("Product name is required");
      return;
    }
    if (!draft.categoryId) {
      setSaveError("Select a category (add one first via Manage categories if none exist)");
      return;
    }
    startSaving(async () => {
      const input = {
        name: draft.name,
        categoryId: draft.categoryId,
        unit: draft.unit,
        tokenPrice: Number(draft.tokenPrice) || 0,
        sellPrice: Number(draft.sellPrice) || 0,
        cost: draft.cost === "" ? null : Number(draft.cost),
        description: draft.description || null,
        flags: draft.flags,
        priceTiers: dedupeTiersByMinQty(
          draft.priceTiers
            .map((t) => ({ minQty: Number(t.minQty) || 0, unitPrice: Number(t.unitPrice) || 0 }))
            .filter((t) => t.minQty > 0 && t.unitPrice > 0),
        ),
      };
      const result =
        modalMode === "create"
          ? await createProductAction(clubId, input)
          : await updateProductAction(clubId, editingId!, input);
      if (!result.ok) {
        setSaveError(result.error);
        return;
      }
      setProducts((prev) =>
        modalMode === "create"
          ? [...prev, result.product]
          : prev.map((p) => (p.id === result.product.id ? result.product : p)),
      );
      showToast(modalMode === "create" ? "Product added" : "Product saved");
      setModalOpen(false);
    });
  }
```

Change the search filter (uses `categoryName` now):

```ts
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => !q || `${p.name} ${p.categoryName}`.toLowerCase().includes(q));
  }, [products, search]);
```

Change the table row's category display:

```tsx
                <div className="text-[13px] text-[#4a4e45]">{p.categoryName}</div>
```

Replace the modal's category `<select>` block:

```tsx
                <div>
                  <label htmlFor="productCategory" className="mb-1 block text-[11px] text-[#8a8e83]">
                    Category
                  </label>
                  <select
                    id="productCategory"
                    value={draft.categoryId}
                    onChange={(e) => setDraft((prev) => ({ ...prev, categoryId: e.target.value }))}
                    className="w-full rounded-[9px] border border-input bg-card px-3 py-2.5 text-[13px]"
                  >
                    {categories.length === 0 && <option value="">No categories yet</option>}
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  {categories.length === 0 && (
                    <p className="mt-1 text-[11px] text-[#9a9e93]">
                      Add a category first via Manage categories above.
                    </p>
                  )}
                </div>
```

- [ ] **Step 4: Update `src/app/[clubSlug]/products/page.tsx`**

```tsx
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import { getProducts } from "@/lib/products";
import { getCategories } from "@/lib/categories";
import { ProductsHeader } from "./products-header";
import { ProductsTable } from "./products-table";
import { CategoriesPanel } from "./categories-panel";

export default async function ProductsPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const supabase = await createClient();
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();
  if (access.role !== "admin") notFound();

  const [products, categories] = await Promise.all([
    getProducts(supabase, access.clubId),
    getCategories(supabase, access.clubId),
  ]);

  return (
    <>
      <ProductsHeader clubName={access.name} count={products.length} />
      <CategoriesPanel clubId={access.clubId} categories={categories} />
      <ProductsTable clubId={access.clubId} products={products} categories={categories} />
    </>
  );
}
```

- [ ] **Step 5: Update `src/app/[clubSlug]/dispense/dispensing-panel.tsx`**

Change the import line:

```ts
import { effectiveUnitPrice, type Product } from "@/lib/products";
import type { ProductCategoryRow } from "@/lib/categories";
```

Delete this block entirely:

```ts
const CATEGORIES: (ProductCategory | "All")[] = [
  "All",
  "Flower",
  "Pre-rolls",
  "Edibles",
  "Concentrate",
  "Accessory",
];
```

Change the component signature to accept `categories`, and change `categoryFilter`'s type:

```ts
export function DispensingPanel({
  clubId,
  products: initialProducts,
  members,
  categories,
}: {
  clubId: string;
  products: Product[];
  members: MemberListRow[];
  categories: ProductCategoryRow[];
}) {
  const { showToast } = useToast();
  const [products, setProducts] = useState(initialProducts);
  const [categoryFilter, setCategoryFilter] = useState<string>("All");
```

Add a memoized chip list (place this alongside the existing `filteredProducts`/`memberResults`/`productById` `useMemo` calls):

```ts
  const categoryChips = useMemo(() => ["All", ...categories.map((c) => c.name)], [categories]);
```

Change `filteredProducts`' filter condition:

```ts
  const filteredProducts = useMemo(() => {
    return products.filter((p) => p.active && (categoryFilter === "All" || p.categoryName === categoryFilter));
  }, [products, categoryFilter]);
```

Change the chip-rendering loop's source array:

```tsx
        <div className="mb-3 flex flex-wrap gap-[7px]">
          {categoryChips.map((c) => (
```

(The rest of that chip `<button>`'s JSX body is unchanged — only the `.map()` source array changes from `CATEGORIES` to `categoryChips`.)

Change the product card's category label:

```tsx
              <div className="flex h-[78px] items-center justify-center bg-accent font-mono text-[10px] text-[#8ba690]">
                {p.categoryName}
              </div>
```

- [ ] **Step 6: Update `src/app/[clubSlug]/dispense/page.tsx`**

```tsx
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import { getProducts } from "@/lib/products";
import { getCategories } from "@/lib/categories";
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

  const [products, members, categories] = await Promise.all([
    getProducts(supabase, access.clubId),
    listMembers(supabase, access.clubId),
    getCategories(supabase, access.clubId),
  ]);

  return (
    <>
      <DispensingHeader />
      <DispensingPanel clubId={access.clubId} products={products} members={members} categories={categories} />
    </>
  );
}
```

- [ ] **Step 7: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no output, exit 0. This is the first point in the whole plan where a zero-error `tsc` run is expected across the entire project.

- [ ] **Step 8: Build**

Run: `node_modules/.bin/next build`
Expected: clean build, no route regressions.

- [ ] **Step 9: Manual smoke test**

Using the demo club (`admin@gaafd.test` / `SmokeTest2026!`, slug `demo`):
- Go to Products. Click "Manage categories" — confirm the 5 existing categories are listed.
- Add a new category (e.g. "Merch"). Confirm it appears in the list and, when creating/editing a product, appears in the category dropdown.
- Rename an existing category. Confirm any product already tagged with it now shows the new name in the product list, without touching the product itself.
- Try deleting a category that's in use by a product — confirm it's blocked with a clear message.
- Delete an unused category — confirm it disappears.
- Go to Dispensing — confirm the category filter chips reflect the club's actual category list (including any custom one just added), and filtering by a custom category correctly shows only matching products.
- Confirm a staff-role login (if one exists for this club) can see categories in Dispensing but has no "Manage categories" panel or category-editing ability on Products (Products is already role-gated entirely, so this should already be blocked at the page level).

- [ ] **Step 10: Commit**

```bash
git add "src/app/[clubSlug]/products/categories-panel.tsx" "src/app/[clubSlug]/products/actions.ts" "src/app/[clubSlug]/products/products-table.tsx" "src/app/[clubSlug]/products/page.tsx" "src/app/[clubSlug]/dispense/dispensing-panel.tsx" "src/app/[clubSlug]/dispense/page.tsx"
git commit -m "Add category management UI and category-aware selects/filters"
```
