# Custom Product Categories — Design Spec

**Status:** Approved
**Scope:** New feature for GaafD, not tied to the original mock (the mock hardcodes 5 categories with no management concept). Triggered by real customer feedback: store owners want to add their own product categories beyond the fixed 5.

## Context

`products.category` is currently `text not null check (category in ('Flower','Pre-rolls','Edibles','Concentrate','Accessory'))` (`supabase/migrations/20260727130000_core_schema.sql:54`). The same fixed 5-value set is duplicated as a TypeScript union (`ProductCategory` in `src/lib/products.ts`) and referenced in three UI spots: the Products create/edit modal's category select, Dispensing's category filter chips, and Dashboard's low-stock alert category abbreviation.

Cottonmouth is a live customer with real products already tagged against these 5 categories — this feature must migrate their existing data, not just add new capability going forward.

## Requirements (confirmed with the user)

- Every club (existing and future) starts with the same 5 categories as today.
- Categories are fully editable per club: rename, delete, add — no permanently "built-in" categories, ordinary rows like Till's `workstations`.
- Renaming a category updates every product tagged with it instantly (no re-tagging).
- Deleting a category in use by any product is blocked with a clear message (matches Products' own delete-guard pattern for itself).
- Management happens on a dedicated panel on the Products screen (admin-only), not scattered quick-add inputs.

## Schema

New table, mirroring `workstations`' shape (`supabase/migrations/20260801140000_till_shifts_schema.sql`):

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

Reads open to everyone (Dispensing's filter chips need this for staff); writes role-aware at the RLS layer (mirroring `shifts_update`/the RBAC-hardening migration) *and* app-layer `assertClubAdmin` — the same two-layer pattern this project settled on for products/contract-templates/till.

`products.category` (text) is replaced by `products.category_id uuid references product_categories(id) on delete restrict`. `on delete restrict` is deliberate: even if the app-layer in-use guard were ever bypassed, the database itself refuses to delete a category still referenced by a product — the same defense-in-depth posture as everywhere else in this project.

## Migrating Cottonmouth's Live Data

This is the risky part — real, currently-in-use product rows must move from a text column to a foreign key with zero data loss and zero downtime for an active customer. Staged, each stage independently verifiable, matching the discipline already used for every prior live-data migration in this project:

1. Seed the 5 default categories for **every existing club**:
   ```sql
   insert into product_categories (club_id, name)
   select c.id, cat.name
   from clubs c
   cross join (values ('Flower'), ('Pre-rolls'), ('Edibles'), ('Concentrate'), ('Accessory')) as cat(name)
   on conflict (club_id, name) do nothing;
   ```
2. Add `products.category_id` as **nullable** initially (a column can't be both added and `not null` in one step without a default, and there's no sensible constant default here — it must be backfilled first).
3. Backfill by matching name within the same club:
   ```sql
   update products p
   set category_id = pc.id
   from product_categories pc
   where pc.club_id = p.club_id and pc.name = p.category;
   ```
   This is guaranteed to match every row 1:1 — the old CHECK constraint only ever allowed the 5 exact names that step 1 just seeded for every club.
4. **Verify zero unmatched rows** (`select count(*) from products where category_id is null` must be `0`) before proceeding — if this is ever non-zero, something is wrong with the assumption above and the migration must stop, not paper over it.
5. Only once verified: `alter table products alter column category_id set not null`, then `alter table products drop column category` (this also drops the old CHECK constraint, which lived on that column).

Future clubs never hit this migration path at all — `createClubAndInviteAdmin` (`src/lib/invites.ts`) is extended to seed the same 5 categories at club-creation time, right after the club row is inserted, using the same rollback-on-failure pattern the function already has (if category seeding fails, the club row is deleted, matching how an admin-invite failure is already handled):

```ts
  if (clubError) throw clubError;

  const { error: categoriesError } = await admin.from("product_categories").insert(
    ["Flower", "Pre-rolls", "Edibles", "Concentrate", "Accessory"].map((name) => ({ club_id: club.id, name })),
  );
  if (categoriesError) {
    await admin.from("clubs").delete().eq("id", club.id);
    throw categoriesError;
  }
```

## Data Layer

### `src/lib/categories.ts` (new)

```ts
export type ProductCategoryRow = { id: string; name: string };

export async function getCategories(supabase: SupabaseClient, clubId: string): Promise<ProductCategoryRow[]>;
export async function createCategory(supabase: SupabaseClient, clubId: string, name: string): Promise<ProductCategoryRow>;
export async function renameCategory(supabase: SupabaseClient, clubId: string, categoryId: string, name: string): Promise<ProductCategoryRow>;
export async function deleteCategory(supabase: SupabaseClient, clubId: string, categoryId: string): Promise<void>;
```

`createCategory`/`renameCategory`/`deleteCategory` all call `assertClubAdmin` first, matching every other admin-only mutation in this codebase. `deleteCategory` checks `products` for any row with this `category_id` before deleting and throws a clear error naming the count if any exist (mirrors `hasProductHistory`'s pattern in `products.ts`) — this is the app-layer half of the delete guard; `on delete restrict` on the FK is the database-layer half.

### `src/lib/products.ts` changes

`ProductCategory` (the fixed union type) is removed. `Product` and `ProductInput` change from `category: ProductCategory` to `categoryId: string` (for writes) plus `categoryName: string` (for display, resolved via lookup — never embedded via PostgREST, matching this project's standing constraint). `PRODUCT_COLUMNS` changes `category` to `category_id`. `getProducts` gains a second lookup query (category ids → names, batched via `.in(...)`) exactly mirroring `getShiftsForDay`'s existing `workstationName` resolution pattern in `till.ts`. `createProduct`/`updateProduct`'s payloads change `category: input.category` to `category_id: input.categoryId`.

### `src/lib/dashboard.ts` changes

`getLowStockAlerts` currently selects `category` directly off `products` for its abbreviation display. It gets the same two-query category-name-lookup treatment as `getProducts` above — its own local version, since it's a separately-filtered query (only low-stock, active products), not a call into `getProducts`.

## UI

**Products screen** (`src/app/[clubSlug]/products/`):
- `page.tsx` fetches `getCategories` alongside `getProducts`, passes the list to both `ProductsTable` and a new `CategoriesPanel`.
- New `categories-panel.tsx` — a collapsible admin-only panel (toggled via a "Manage categories" button next to "+ New product"), listing every category with inline rename (click to edit, matching this app's existing inline-edit conventions) and a delete button (blocked with the server's exact error message if in use), plus a small add-new input at the bottom. New server actions `createCategoryAction`/`renameCategoryAction`/`deleteCategoryAction` added to `products/actions.ts`, same `{ok,error}` contract as every other action in this file.
- `products-table.tsx`'s create/edit modal: the category `<select>` is now populated from the `categories` prop (id/name pairs) instead of a hardcoded array. If a club somehow has zero categories (shouldn't happen given seeding, but defensively), the field shows a short message pointing at the Manage categories panel and Save is disabled — no quick-add inside the modal itself, per the approved design (management lives on the panel, not scattered inline).

**Dispensing screen** (`src/app/[clubSlug]/dispense/`): `page.tsx` fetches `getCategories` and passes it down; the hardcoded `CATEGORIES` array in `dispensing-panel.tsx` is replaced with `["All", ...categories.map(c => c.name)]`, and the filter comparison changes from `p.category === categoryFilter` to `p.categoryName === categoryFilter`. Custom categories show up as filter chips automatically, no code change needed per-category.

**Dashboard**: no UI change beyond the data-layer fix above — the low-stock alert's category abbreviation (`alert.category.slice(0,3).toUpperCase()`) keeps working exactly as it does today, now backed by a resolved name instead of raw column text.

## Testing

**Shared fixture change (touches nearly every existing test file, must land first):** `tests/rls/fixtures.ts`'s `seedClub()` currently inserts its one seeded product with a hardcoded `category: "Flower"` text value. Since new-club category seeding lives in application code (`createClubAndInviteAdmin`), not a database trigger, `seedClub()`'s throwaway clubs — created by a direct `admin.from("clubs").insert(...)`, not through that function — never go through it and would otherwise end up with a `category_id`-requiring product and zero categories to reference. `seedClub()` must insert one `product_categories` row (e.g. named `"Flower"`, matching today's fixture product's category for continuity) immediately before inserting the fixture product, and reference its id as `category_id`. This is a one-time, narrowly-scoped change to a single function, but because `seedClub()` backs nearly every test file in this project (`products.test.ts`, `dispensing.test.ts`, `till.test.ts`, `donations.test.ts`, `inventory.test.ts`, `members.test.ts`, `contracts.test.ts`, and more), it must be verified by running the **full** test suite, not just the files this feature otherwise touches.

- `tests/categories.test.ts` (new): `getCategories` cross-tenant isolation; `createCategory` rejects staff, admin succeeds; `renameCategory` updates the name and is immediately reflected for any product referencing it (verified by re-fetching the product's `categoryName` via `getProducts`, not just the category row itself); `deleteCategory` succeeds when unused, is rejected with a clear error when a product references it, and rejects staff.
- `tests/products.test.ts`: update existing tests' `ProductInput` literals from `category: "Flower"` to `categoryId: <a seeded category's id>`, using the fixture's newly-seeded category row (see above) or a locally-created one where a test specifically needs its own.
- `tests/dashboard.test.ts` (if low-stock-alert category display is covered there already): confirm `category` in the returned alert is the resolved name, not an id.
- Full suite run (`vitest run`, no file filter) as the final check for this feature, specifically because of the shared-fixture change above — any test file this spec didn't anticipate touching could still break if it constructs a `products` row directly rather than through `seedClub()`.
- UI verified via `tsc`/`build`/manual smoke test only, per this project's established convention.

## Global Constraints

- Reuse `src/lib/auth/require-role.ts`'s `assertClubAdmin`, `src/lib/supabase/server.ts`, `src/lib/toast-context.tsx`'s `useToast` exactly as they exist — do not modify any of them.
- This plan explicitly modifies `src/lib/products.ts`, `src/lib/dashboard.ts`, `src/lib/invites.ts`, `src/app/[clubSlug]/products/products-table.tsx`, `src/app/[clubSlug]/dispense/dispensing-panel.tsx`, and `tests/rls/fixtures.ts` — unlike most prior plans' "reuse exactly as-is" instruction, these are the feature's whole point (`fixtures.ts`'s change is narrow — one product-seeding insert — but touches every test file that depends on it, see Testing).
- No PostgREST relation embedding anywhere — every category-name resolution is a separate batched query + in-memory map, matching `getShiftsForDay`'s established pattern.
- No shadcn/`@base-ui/react` components — hand-rolled Tailwind, matching every prior screen.
- Every labeled form field needs `htmlFor`/`id` pairing.
- Migration files follow the existing `YYYYMMDDHHMMSS_description.sql` naming, applied via `supabase db push --linked` against the live linked project (ref `inlseklfbptgjketdnpe`) — **this project has real customer data (Cottonmouth) in it now.** The backfill-and-drop-column migration is destructive (drops `products.category`) and must be preceded by the explicit zero-unmatched-rows verification described above, not assumed.
- pnpm exclusively, Node via `.nvmrc`, commit messages plain/imperative, work on branch `master` directly (standing consent from all prior phases).
