# Inventory Screen — Design Spec

**Status:** Approved
**Scope:** Phase 5, next screen for GaafD (South African cannabis social club SaaS). Adds `/[clubSlug]/inventory` — currently unbuilt (sidebar's "Inventory" link 404s today).

## Context

Design reference: `/Users/user/Documents/projects/gaafd/README.md` (§11 "Inventory — append-only ledger"), `design/GaafD.dc.html` (lines 621-656 list view, 790-814 add-movement modal, 1403-1419 the movement-save business logic), `screenshots/06-inventory.png`. The `inventory_moves` table and `product_stock` view already exist (phase 1) — append-only (SELECT + INSERT RLS only, no UPDATE/DELETE), exactly matching the screen's own "immutable audit trail" framing.

`inventory_moves.staff_id` references `club_users.id` (the membership row), not `auth.users(id)` directly — confirmed against the schema.

**Schema addition required**: displaying "who logged this movement" needs the acting staff member's email. `auth.users` is not exposed via PostgREST and ordinary authenticated clients cannot read other users' rows there (no admin-client dependency belongs in a plain read path, and this project never uses the service-role client outside test fixtures/admin-only flows). The fix: capture the email as a **snapshot** at creation time, the same principle already used for `signed_contracts.contract_snapshot` — the row records what was true when it was created, immutably, rather than requiring a later cross-user lookup that isn't possible anyway. New migration:
```sql
alter table inventory_moves add column staff_email text;
```
Nullable, additive, no data migration needed for the one existing seeded row per fixture club. `staff_id` (the FK) stays as-is for referential linkage; `staff_email` is purely a display snapshot, populated from the acting user's own session at insert time (`supabase.auth.getUser()`, always safely readable about oneself — no elevated privilege needed).

## Data Layer

### `src/lib/inventory.ts` (new)

```ts
export type MovementType = "PURCHASE" | "SALE" | "ADJUSTMENT" | "WASTE";
export type LoggableMovementType = "PURCHASE" | "ADJUSTMENT" | "WASTE";

export type Movement = {
  id: string;
  type: MovementType;
  productId: string;
  productName: string;
  qty: number; // signed
  cost: number | null;
  batch: string | null;
  expiry: string | null; // ISO date
  staffEmail: string | null;
  createdAt: string;
};

export async function getMovements(
  supabase: SupabaseClient,
  clubId: string,
  filters?: { productId?: string; type?: MovementType },
): Promise<Movement[]>;

export type CreateMovementInput = {
  productId: string;
  type: LoggableMovementType;
  qty: number; // raw user-entered value, sign gets normalized server-side
  cost?: number | null;
  batch?: string | null;
  expiry?: string | null; // ISO date (YYYY-MM-DD)
};

export async function createMovement(
  supabase: SupabaseClient,
  clubId: string,
  input: CreateMovementInput,
): Promise<{ movement: Movement; newStock: number }>;
```

**`getMovements`**: two sequential queries (no PostgREST embedding) — `inventory_moves` filtered by `club_id` and the optional `productId`/`type`, then `getProducts`-equivalent name resolution via a `products` query scoped to the same club, joined in JS. Newest first (`created_at desc`). Staff display reads `staff_email` directly off each row (the snapshot column above) — no cross-table lookup needed.

**`createMovement`** — `type` is typed as `LoggableMovementType`, excluding `SALE` at the type level: SALE is reserved for the future Dispensing/POS screen to write automatically when a member redeems a product, never manually enterable here (matches the mock's own add-movement modal, which only offers PURCHASE/ADJUSTMENT/WASTE).

Business logic, replicated exactly from the mock's `saveMovement()`:
- Reject if `qty` is zero or not a finite number.
- Sign normalization (server-side, not trusting whatever sign the client sent): `PURCHASE` → stored as `+|qty|`; `WASTE` → stored as `-|qty|`; `ADJUSTMENT` → stored exactly as entered (can be either sign).

Two defense-in-depth checks (established project convention — RLS is the backstop, not the only check):
1. **Product ownership**: verify `productId` belongs to `clubId` (query `products` with both filters, throw if not found) before inserting — a malicious client could otherwise submit a foreign product id even though the UI's dropdown only ever lists the caller's own products.
2. **Staff identity, never client-supplied**: resolve the acting user's own `club_users.id` (for `staff_id`) and email (for `staff_email`, see the snapshot note above) server-side via `supabase.auth.getUser()` + a `club_users` lookup scoped to `clubId` + that user id. The client never sends a `staffId` or a staff email.

Returns both the created `Movement` and the product's `newStock` (a fresh `product_stock` read after the insert) — the mock's own toast shows "stock now {N}", so the UI needs this without a second round-trip.

## Screen

Same Server Component + Client Component split as every prior screen.

- `src/app/[clubSlug]/inventory/page.tsx` — `resolveClubAccess` + `notFound()`, `getProducts` (for the filter dropdown + modal's product select) and `getMovements` in parallel, renders header + table.
- `src/app/[clubSlug]/inventory/inventory-header.tsx` — title "Inventory", subtitle "Append-only stock movement ledger" (the mock's own static copy for this screen — unlike Members/Products, this subtitle describes the ledger rather than showing a count, matching what the design mock actually says here).
- `src/app/[clubSlug]/inventory/inventory-table.tsx` — Client Component:
  - Filters: product dropdown ("All products" + list) and type chips (All/PURCHASE/SALE/ADJUSTMENT/WASTE — SALE is filterable even though not manually loggable, since it'll start appearing once Dispensing exists), both client-side over the already-fetched list. No pagination (matches Members/Products' own simplification away from the mock's paginated table).
  - The immutable-audit-trail notice banner, copy matching the mock exactly: "Movements are an immutable audit trail — entries can't be edited or deleted. Correct mistakes by appending an ADJUSTMENT or WASTE."
  - Table columns: Type (tag), Product, Qty (mono, signed, colored green/red by sign, unit-suffixed only when the product's `unit` contains "g" — matching the mock's own exact formatting, which differs slightly from Dashboard's low-stock "g"/"u" fallback by using no suffix at all for non-gram units here), Cost R, Batch/Expiry, Staff (email), Date.
  - "+ Log movement" opens a hand-rolled modal (product select, type select [3 options only — no SALE], quantity, cost, batch, **expiry as a real `<input type="date">`**, not the mock's "MM/YY" text convention — the schema column is a genuine `date`, and matching that is more correct than copying the mock's simplified prototype input, the same call already made for Products' cost/sell decimal fields). Reuses the exact overlay/backdrop/Escape-key pattern established by Products' modal.
  - No row actions, no row click — this screen never had either, even in the mock (append-only, nothing to edit).
  - Empty states: genuinely zero movements ("No movements yet — log your first inventory movement to get started") vs. filtered-to-zero ("No movements match your filters").

## Testing

- `tests/inventory.test.ts`, live Supabase, reusing `tests/rls/fixtures.ts` (which already seeds one `PURCHASE` movement of qty 100 per club's fixture product — tests account for this non-empty baseline). Covers: cross-tenant read isolation (`getMovements` never returns another club's rows); sign normalization for all three loggable types; the productId-ownership defense-in-depth check (creating a movement against another club's product id is rejected); `newStock` reflects the correct post-insert total via `product_stock`.
- UI verified via `tsc`/`build`/manual smoke test only, per this project's established convention.

## Global Constraints

- Reuse `src/lib/supabase/server.ts`, `src/lib/auth/club-access.ts`'s `resolveClubAccess`, `src/lib/page-header-context.tsx`'s `usePageHeader`, `src/lib/toast-context.tsx`'s `useToast`, and `src/lib/products.ts`'s `getProducts` exactly as they exist — do not modify any of them.
- No PostgREST relation embedding anywhere.
- No shadcn/`@base-ui/react` components — hand-rolled Tailwind markup, matching Products' precedent for the modal.
- Design tokens: `@theme`-mapped Tailwind utility classes wherever they map exactly; arbitrary hex only where genuinely absent from the mapped set.
- Every labeled form field needs `htmlFor`/`id` pairing.
- pnpm exclusively, Node via `.nvmrc`, commit messages plain/imperative, work on branch `master` directly (standing consent from all prior phases).
