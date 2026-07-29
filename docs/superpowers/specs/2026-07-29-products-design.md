# Products Screen — Design Spec

**Status:** Approved
**Scope:** Phase 5, next screen for GaafD (South African cannabis social club SaaS). Adds `/[clubSlug]/products` — currently unbuilt (sidebar's "Products" link 404s today).

## Context

Design reference: `/Users/user/Documents/projects/gaafd/README.md` (§ "Products"), `design/GaafD.dc.html` (lines 531-565 for the list, 746-774 for the create/edit modal, 776-788 for the delete-confirm dialog, 1112-1179 for the CRUD logic), `screenshots/05-products.png`. The `products` table and its RLS already exist (phase 1); `product_stock` (a derived view over `inventory_moves`) already exists and is already consumed by the Dashboard's low-stock alerts.

**Scope decisions (deliberate, mirror precedent set by Dashboard/Members list):**
- Rows are **not clickable** — Product Detail (the mock's row-click destination) doesn't exist yet. No dead-end affordance.
- "History" for the delete guard means **inventory movements only**. The mock's guard also considers order history, but no dispense-order table exists yet (Dispensing/POS isn't built) — same reasoning as every prior schema-gap decision this session (Dashboard's token-ledger gap, etc.).
- **No pagination** — mirrors Members list's own simplification. A club's product catalog is expected to be small; the whole list is fetched once and filtered client-side.
- **Delete guard moves to the list screen** (user-approved): the mock's guard logic (deactivate instead of delete when history exists) lives on Product Detail in the mock. Since that screen doesn't exist here, the list's delete-confirm dialog absorbs the guard: one dialog, server-determined content — "Delete permanently" when there's no history, "Deactivate"/"Reactivate" with an explanation when there is.

## Data Layer

### `src/lib/products.ts` (new)

```ts
export type Product = {
  id: string;
  name: string;
  category: "Flower" | "Pre-rolls" | "Edibles" | "Concentrate" | "Accessory";
  unit: string;
  tokenPrice: number;
  sellPrice: number;
  cost: number | null;
  description: string | null;
  flags: string[]; // subset of "app" | "gift" | "nodisc"
  active: boolean;
  stock: number;
};

export async function getProducts(supabase: SupabaseClient, clubId: string): Promise<Product[]>;
```
Two sequential queries (no PostgREST embedding, this codebase's established convention): all products for the club, then `product_stock` filtered to those product ids. Joined in JS via a `Map`; a product with no `product_stock` row (zero inventory moves ever) defaults to `stock: 0` — this is the same edge case already documented and accepted in the Dashboard's final review, just handled directly here instead of being invisible (Dashboard's low-stock query only cared about products AT the threshold; this screen must show every product's real stock, including 0).

```ts
export type ProductInput = {
  name: string;
  category: Product["category"];
  unit: string;
  tokenPrice: number;
  sellPrice: number;
  cost?: number | null;
  description?: string | null;
  flags: string[];
};

export async function createProduct(supabase: SupabaseClient, clubId: string, input: ProductInput): Promise<Product>;
export async function updateProduct(supabase: SupabaseClient, productId: string, input: ProductInput): Promise<Product>;
```
`createProduct` inserts with `active: true` and never touches `inventory_moves` — a new product genuinely has zero stock (no row in `product_stock`) until Inventory (not yet built) logs a movement. `updateProduct` never touches `active` or stock — matches the mock's own "stock isn't editable here" rule.

```ts
export async function hasProductHistory(supabase: SupabaseClient, productId: string): Promise<boolean>;
```
True if any `inventory_moves` row references the product (a simple existence check, `.select("id", {head:true, count:"exact"}).eq("product_id", productId).limit(1)` or equivalent).

```ts
export type DeleteOrDeactivateResult =
  | { action: "deleted" }
  | { action: "deactivated" }
  | { action: "reactivated" };

export async function deleteOrDeactivateProduct(
  supabase: SupabaseClient,
  productId: string,
): Promise<DeleteOrDeactivateResult>;
```
Re-checks history **server-side** at call time (not trusting a client-side read from page-load — a movement could theoretically land between the page rendering and the user clicking delete): if no history, hard-deletes the row and returns `{action:"deleted"}`; if history exists, toggles `active` (reading the row's current `active` value first) and returns `{action:"deactivated"}` or `{action:"reactivated"}` accordingly.

## Screen

### `src/app/[clubSlug]/products/page.tsx` (new, Server Component)
`resolveClubAccess` + `notFound()`, `getProducts`, renders `<ProductsHeader count={...} clubName={...} />` + `<ProductsTable clubId={...} clubSlug={...} products={...} />`.

### `src/app/[clubSlug]/products/products-header.tsx` (new, tiny Client Component)
Same shape as `members-header.tsx`/`dashboard-header.tsx`. Title "Products", subtitle `"{count} products · {clubName}"`.

### `src/app/[clubSlug]/products/products-table.tsx` (new, Client Component)
- Local search state, filtering the already-fetched list client-side by name+category (mirrors Members list's search pattern exactly).
- "+ New product" opens the create/edit modal in create mode.
- Table columns matching the mock: **Product** (placeholder avatar + name + unit beneath, "inactive" tag if `!active`), **Category**, **Stock** (mono, red at `stock <= 8` — reusing the same threshold concept as Dashboard's `LOW_STOCK_THRESHOLD`), **Token** (mono), **Sell R** (mono), **Flags** (chips: "App" reuses `bg-status-active-bg`/`text-status-active-fg` since its color pair matches exactly; "Gift"/"No disc" use arbitrary hex matching the mock, no clean token equivalent exists), **Actions** (edit ✎, delete 🗑 icon buttons).
- Empty states: genuinely zero products ("No products yet — add your first product to get started") vs. filtered-to-zero ("No products match your search").

### Create/Edit modal (within `products-table.tsx`, not a separate file — small enough to stay co-located, same judgment call as Dashboard's inline `KpiCard`/`ActivityRow`)
Fields matching the mock exactly: name* (text, required), category (select: Flower/Pre-rolls/Edibles/Concentrate/Accessory — matches the `products.category` check constraint), unit (text, e.g. "per 1g"/"each"/"pack"), token price (integer input — schema is `integer`), cost (Rand, **decimals allowed** — the schema is `numeric(10,2)`; the mock's own input mask strips to whole numbers only, but that's a mock limitation, not a real constraint, so this build supports cents), sell price (Rand, decimals allowed, same reasoning), description (textarea, optional), flags (3 toggle buttons: "Show in app" / "Gifting allowed" / "Discount-exempt", mapping to `app`/`gift`/`nodisc`). Edit mode shows the mock's "stock isn't editable here — log a movement in Inventory" notice (inert copy for now, since Inventory isn't built; no link).

### Delete-confirm dialog (within `products-table.tsx`)
Opens on trash-icon click. Calls `hasProductHistory` first (or `deleteOrDeactivateProduct` could return enough info in one call — implementation detail for the plan to settle) to decide which copy to show:
- No history: "Delete product? — `{name}` has no inventory history, so it can be permanently removed. This can't be undone." → "Delete permanently" button.
- Has history: "Can't delete `{name}` — it has {N} inventory movement(s) on record. History is immutable, so it can only be deactivated." → "Deactivate"/"Reactivate" button (label depends on current `active` state).

Both paths call `deleteOrDeactivateProduct`, which re-verifies server-side regardless of which copy was shown — the dialog copy is a UX convenience, not the enforcement point.

## Testing

- `tests/products.test.ts` (new), live Supabase, reusing `tests/rls/fixtures.ts`. Covers: `getProducts` returns only the caller's club's products (cross-tenant check) with correct stock (including 0 for a product with no moves); `createProduct`/`updateProduct` round-trip correctly and never touch stock; `hasProductHistory` is true/false correctly; `deleteOrDeactivateProduct` hard-deletes a history-less product and toggles `active` for one with history, re-verified server-side (not trusting a stale client read).
- UI verified via `tsc`/`build`/manual smoke test only, per this project's established convention.

## Global Constraints

- Reuse `src/lib/supabase/server.ts`, `src/lib/auth/club-access.ts`'s `resolveClubAccess`, `src/lib/page-header-context.tsx`'s `usePageHeader` exactly as they exist — do not modify.
- No PostgREST relation embedding anywhere (established codebase convention).
- Design tokens: `@theme`-mapped Tailwind utilities (`rounded-card`, `bg-card`, `border-border`, `bg-status-active-bg`/`text-status-active-fg`, `font-heading`, `font-mono`, `text-destructive`) matching every prior screen; arbitrary `text-[#hex]`/`bg-[#hex]` only for values genuinely absent from the mapped set. `--destructive` is `#b4432f`, matching both the mock's low-stock red and its delete-button red exactly — use `text-destructive` for the stock-low color and the delete-confirm button, not an arbitrary hex. The gift/no-disc flag chip colors have no mapped equivalent and stay arbitrary.
- pnpm exclusively, Node via `.nvmrc`, commit messages plain/imperative, work on branch `master` directly (standing consent from all prior phases).
