# Inventory Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `/[clubSlug]/inventory` — the append-only stock movement ledger with product/type filters and a "Log movement" modal, currently unbuilt (sidebar's "Inventory" link 404s today).

**Architecture:** A schema migration (a `staff_email` snapshot column, needed because ordinary clients can't read other users' `auth.users` rows), then a data layer (`src/lib/inventory.ts`) replicating the mock's exact sign-normalization business logic, then a single UI task reusing the modal/overlay pattern Products already established.

**Tech Stack:** Next.js App Router, TypeScript, Supabase JS client, Vitest.

## Global Constraints

- Reuse `src/lib/supabase/server.ts`, `src/lib/auth/club-access.ts`'s `resolveClubAccess`, `src/lib/page-header-context.tsx`'s `usePageHeader`, `src/lib/toast-context.tsx`'s `useToast`, `src/lib/products.ts`'s `getProducts` exactly as they exist — do not modify any of them.
- No PostgREST relation embedding anywhere.
- No shadcn/`@base-ui/react` components — hand-rolled Tailwind markup, matching Products' precedent.
- Every labeled form field needs `htmlFor`/`id` pairing.
- Migration files follow the existing `YYYYMMDDHHMMSS_description.sql` naming, applied via `supabase db push --linked` against the live linked project (ref `inlseklfbptgjketdnpe`).
- pnpm exclusively, Node via `.nvmrc` (run `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use` before any command).
- Commit messages plain, imperative. Work on branch `master` directly (standing consent from all prior phases).
- `tests/rls/fixtures.ts`'s `SeededClub` already has `productId` and `inventoryMoveId` fields (one `PURCHASE` move of qty 100 on "Test Product" per club) — Task 2's tests build on this baseline sequentially, mutating the same fixture product's stock across the `createMovement` tests in a documented running total, matching this project's established sequential-test convention (e.g. `tests/dashboard.test.ts`'s low-stock sequence).

---

### Task 1: Migration — `staff_email` snapshot column

**Files:**
- Create: `supabase/migrations/20260729150000_inventory_staff_email.sql`

**Interfaces:**
- Produces: `inventory_moves.staff_email` (nullable text) — consumed by Task 2.

No application code in this task — pure schema, verified against the live project directly.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260729150000_inventory_staff_email.sql`:

```sql
alter table inventory_moves add column staff_email text;
```

- [ ] **Step 2: Apply the migration**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use && supabase db push --linked`
Expected: lists the new migration, applies it, ends with `Finished supabase db push.`

- [ ] **Step 3: Verify nothing is left pending**

Run: `supabase db push --linked --dry-run`
Expected: no pending migrations listed.

- [ ] **Step 4: Verify against the live project**

```sql
select column_name, is_nullable from information_schema.columns
where table_name = 'inventory_moves' and column_name = 'staff_email';
```
Expected: one row, `is_nullable = YES`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260729150000_inventory_staff_email.sql
git commit -m "Add staff_email snapshot column to inventory_moves"
```

---

### Task 2: Inventory data layer

**Files:**
- Create: `src/lib/inventory.ts`
- Test: `tests/inventory.test.ts`

**Interfaces:**
- Consumes: Task 1's `staff_email` column.
- Produces: `type MovementType`, `type LoggableMovementType`, `type Movement`, `type CreateMovementInput`, `getMovements(supabase, clubId, filters?): Promise<Movement[]>`, `createMovement(supabase, clubId, input): Promise<{ movement: Movement; newStock: number }>` — all consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

Create `tests/inventory.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedTenants, cleanupTenants, signInAs, type SeededData } from "./rls/fixtures";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMovements, createMovement } from "@/lib/inventory";

let data: SeededData;
let clubAClient: SupabaseClient;
let clubBClient: SupabaseClient;
const cleanupMoveIds: string[] = [];

beforeAll(async () => {
  data = await seedTenants();
  clubAClient = await signInAs(data.clubA.adminEmail, data.clubA.adminPassword);
  clubBClient = await signInAs(data.clubB.adminEmail, data.clubB.adminPassword);
}, 30000);

afterAll(async () => {
  const admin = createAdminClient();
  if (cleanupMoveIds.length > 0) {
    await admin.from("inventory_moves").delete().in("id", cleanupMoveIds);
  }
  if (data) {
    await cleanupTenants(data);
  }
}, 30000);

describe("getMovements", () => {
  it("returns only the caller's club's movements, not club B's", async () => {
    const movements = await getMovements(clubAClient, data.clubA.clubId);
    const ids = movements.map((m) => m.id);
    expect(ids).toContain(data.clubA.inventoryMoveId);
    expect(ids).not.toContain(data.clubB.inventoryMoveId);
  });

  it("resolves the product name for the fixture's seeded PURCHASE move", async () => {
    const movements = await getMovements(clubAClient, data.clubA.clubId);
    const fixtureMove = movements.find((m) => m.id === data.clubA.inventoryMoveId);
    expect(fixtureMove).toBeDefined();
    expect(fixtureMove!.productName).toBe("Test Product");
    expect(fixtureMove!.type).toBe("PURCHASE");
    expect(fixtureMove!.qty).toBe(100);
  });

  it("filters by type", async () => {
    const movements = await getMovements(clubAClient, data.clubA.clubId, { type: "WASTE" });
    expect(movements.every((m) => m.type === "WASTE")).toBe(true);
  });

  it("filters by productId", async () => {
    const movements = await getMovements(clubAClient, data.clubA.clubId, {
      productId: data.clubA.productId,
    });
    expect(movements.every((m) => m.productId === data.clubA.productId)).toBe(true);
  });
});

describe("createMovement", () => {
  it("normalizes PURCHASE to a positive quantity regardless of entered sign", async () => {
    const { movement, newStock } = await createMovement(clubAClient, data.clubA.clubId, {
      productId: data.clubA.productId,
      type: "PURCHASE",
      qty: -50,
    });
    cleanupMoveIds.push(movement.id);
    expect(movement.qty).toBe(50);
    expect(movement.staffEmail).toBe(data.clubA.adminEmail);
    expect(newStock).toBe(150);
  });

  it("normalizes WASTE to a negative quantity regardless of entered sign", async () => {
    const { movement, newStock } = await createMovement(clubAClient, data.clubA.clubId, {
      productId: data.clubA.productId,
      type: "WASTE",
      qty: 10,
    });
    cleanupMoveIds.push(movement.id);
    expect(movement.qty).toBe(-10);
    expect(newStock).toBe(140);
  });

  it("keeps ADJUSTMENT's entered sign as-is", async () => {
    const { movement, newStock } = await createMovement(clubAClient, data.clubA.clubId, {
      productId: data.clubA.productId,
      type: "ADJUSTMENT",
      qty: -5,
    });
    cleanupMoveIds.push(movement.id);
    expect(movement.qty).toBe(-5);
    expect(newStock).toBe(135);
  });

  it("rejects a zero quantity", async () => {
    await expect(
      createMovement(clubAClient, data.clubA.clubId, {
        productId: data.clubA.productId,
        type: "ADJUSTMENT",
        qty: 0,
      }),
    ).rejects.toThrow();
  });

  it("rejects a product belonging to a different club", async () => {
    await expect(
      createMovement(clubAClient, data.clubA.clubId, {
        productId: data.clubB.productId,
        type: "PURCHASE",
        qty: 10,
      }),
    ).rejects.toThrow("Product not found in this club");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/inventory.test.ts`
Expected: FAIL — `Cannot find module '@/lib/inventory'`. (Requires Task 1's migration to already be live, which it is by this point.)

- [ ] **Step 3: Implement**

Create `src/lib/inventory.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

export type MovementType = "PURCHASE" | "SALE" | "ADJUSTMENT" | "WASTE";
export type LoggableMovementType = "PURCHASE" | "ADJUSTMENT" | "WASTE";

export type Movement = {
  id: string;
  type: MovementType;
  productId: string;
  productName: string;
  qty: number;
  cost: number | null;
  batch: string | null;
  expiry: string | null;
  staffEmail: string | null;
  createdAt: string;
};

type MovementRow = {
  id: string;
  type: MovementType;
  product_id: string;
  qty: number;
  cost: number | null;
  batch: string | null;
  expiry: string | null;
  staff_email: string | null;
  created_at: string;
};

const MOVEMENT_COLUMNS = "id, type, product_id, qty, cost, batch, expiry, staff_email, created_at";

export async function getMovements(
  supabase: SupabaseClient,
  clubId: string,
  filters?: { productId?: string; type?: MovementType },
): Promise<Movement[]> {
  let query = supabase
    .from("inventory_moves")
    .select(MOVEMENT_COLUMNS)
    .eq("club_id", clubId)
    .order("created_at", { ascending: false });
  if (filters?.productId) query = query.eq("product_id", filters.productId);
  if (filters?.type) query = query.eq("type", filters.type);

  const { data: moves, error: movesError } = await query;
  if (movesError) throw movesError;

  const rows = moves ?? [];
  if (rows.length === 0) return [];

  const { data: products, error: productsError } = await supabase
    .from("products")
    .select("id, name")
    .eq("club_id", clubId);
  if (productsError) throw productsError;

  const nameByProductId = new Map((products ?? []).map((p) => [p.id as string, p.name as string]));

  return rows.map((row) => {
    const m = row as MovementRow;
    return {
      id: m.id,
      type: m.type,
      productId: m.product_id,
      productName: nameByProductId.get(m.product_id) ?? "—",
      qty: Number(m.qty),
      cost: m.cost === null ? null : Number(m.cost),
      batch: m.batch,
      expiry: m.expiry,
      staffEmail: m.staff_email,
      createdAt: m.created_at,
    };
  });
}

export type CreateMovementInput = {
  productId: string;
  type: LoggableMovementType;
  qty: number;
  cost?: number | null;
  batch?: string | null;
  expiry?: string | null;
};

function normalizeQty(type: LoggableMovementType, qty: number): number {
  if (type === "PURCHASE") return Math.abs(qty);
  if (type === "WASTE") return -Math.abs(qty);
  return qty;
}

export async function createMovement(
  supabase: SupabaseClient,
  clubId: string,
  input: CreateMovementInput,
): Promise<{ movement: Movement; newStock: number }> {
  if (!Number.isFinite(input.qty) || input.qty === 0) {
    throw new Error("Enter a valid, non-zero quantity");
  }

  // Defense-in-depth: RLS's inventory_moves INSERT policy only checks the
  // NEW row's own club_id — it doesn't verify product_id actually belongs
  // to that same club.
  const { data: product, error: productError } = await supabase
    .from("products")
    .select("id, name")
    .eq("id", input.productId)
    .eq("club_id", clubId)
    .maybeSingle();
  if (productError) throw productError;
  if (!product) throw new Error("Product not found in this club");

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const { data: membership, error: membershipError } = await supabase
    .from("club_users")
    .select("id")
    .eq("club_id", clubId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (membershipError) throw membershipError;
  if (!membership) throw new Error("Not a member of this club");

  const qty = normalizeQty(input.type, input.qty);

  const { data, error } = await supabase
    .from("inventory_moves")
    .insert({
      club_id: clubId,
      product_id: input.productId,
      type: input.type,
      qty,
      cost: input.cost ?? null,
      batch: input.batch || null,
      expiry: input.expiry || null,
      staff_id: membership.id,
      staff_email: user.email ?? null,
    })
    .select(MOVEMENT_COLUMNS)
    .single();
  if (error) throw error;

  const { data: stockRow } = await supabase
    .from("product_stock")
    .select("stock")
    .eq("product_id", input.productId)
    .eq("club_id", clubId)
    .maybeSingle();

  const m = data as MovementRow;
  const movement: Movement = {
    id: m.id,
    type: m.type,
    productId: m.product_id,
    productName: product.name as string,
    qty: Number(m.qty),
    cost: m.cost === null ? null : Number(m.cost),
    batch: m.batch,
    expiry: m.expiry,
    staffEmail: m.staff_email,
    createdAt: m.created_at,
  };

  return { movement, newStock: stockRow?.stock ?? 0 };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/inventory.test.ts`
Expected: PASS, all tests green. Live Supabase project — this will take longer than a mocked suite.

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/inventory.ts tests/inventory.test.ts
git commit -m "Add inventory data layer (list, filtered, sign-normalized log-movement)"
```

---

### Task 3: Inventory screen UI

**Files:**
- Create: `src/app/[clubSlug]/inventory/page.tsx`
- Create: `src/app/[clubSlug]/inventory/inventory-header.tsx`
- Create: `src/app/[clubSlug]/inventory/inventory-table.tsx`
- Create: `src/app/[clubSlug]/inventory/actions.ts`

**Interfaces:**
- Consumes: `getMovements`, `createMovement`, and the `Movement`/`MovementType`/`LoggableMovementType`/`CreateMovementInput` types from `src/lib/inventory.ts` (Task 2). `getProducts`/`Product` from `src/lib/products.ts` (existing). `resolveClubAccess` from `src/lib/auth/club-access.ts` (existing). `usePageHeader` from `src/lib/page-header-context.tsx` (existing). `useToast` from `src/lib/toast-context.tsx` (existing).

This task has no test file — verified via `tsc`/`build`/manual smoke test, per this project's established convention for UI-only tasks.

- [ ] **Step 1: Create the header component**

Create `src/app/[clubSlug]/inventory/inventory-header.tsx`:

```tsx
"use client";

import { usePageHeader } from "@/lib/page-header-context";

export function InventoryHeader() {
  usePageHeader({ title: "Inventory", subtitle: "Append-only stock movement ledger" });
  return null;
}
```

- [ ] **Step 2: Create the server action**

Create `src/app/[clubSlug]/inventory/actions.ts`:

```ts
"use server";

import { createClient } from "@/lib/supabase/server";
import { createMovement, type CreateMovementInput, type Movement } from "@/lib/inventory";

export async function createMovementAction(
  clubId: string,
  input: CreateMovementInput,
): Promise<{ ok: true; movement: Movement; newStock: number } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const { movement, newStock } = await createMovement(supabase, clubId, input);
    return { ok: true, movement, newStock };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to log movement" };
  }
}
```

- [ ] **Step 3: Create the table component**

Create `src/app/[clubSlug]/inventory/inventory-table.tsx`:

```tsx
"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useToast } from "@/lib/toast-context";
import { createMovementAction } from "./actions";
import type { Movement, MovementType, LoggableMovementType } from "@/lib/inventory";
import type { Product } from "@/lib/products";

const TYPE_FILTERS: (MovementType | "All")[] = ["All", "PURCHASE", "SALE", "ADJUSTMENT", "WASTE"];
const LOGGABLE_TYPES: LoggableMovementType[] = ["PURCHASE", "ADJUSTMENT", "WASTE"];

const TYPE_TAG_STYLE: Record<MovementType, { background: string; color: string }> = {
  PURCHASE: { background: "var(--status-active-bg)", color: "var(--status-active-fg)" },
  SALE: { background: "#eef0f6", color: "#4a5e8a" },
  ADJUSTMENT: { background: "#f6efe0", color: "#8a6d3b" },
  WASTE: { background: "#f8e9e4", color: "#b4432f" },
};

type MovementDraft = {
  productId: string;
  type: LoggableMovementType;
  qty: string;
  cost: string;
  batch: string;
  expiry: string;
};

function emptyDraft(products: Product[]): MovementDraft {
  return {
    productId: products[0]?.id ?? "",
    type: "PURCHASE",
    qty: "",
    cost: "",
    batch: "",
    expiry: "",
  };
}

function hintForType(type: LoggableMovementType): string {
  if (type === "PURCHASE") return "Increments product stock";
  if (type === "WASTE") return "Decrements product stock";
  return "Signed adjustment — prefix with − to reduce";
}

function formatQty(qty: number, unit: string): string {
  const suffix = unit.includes("g") ? "g" : "";
  return (qty > 0 ? "+" : "−") + Math.abs(qty) + suffix;
}

export function InventoryTable({
  clubId,
  products,
  movements: initialMovements,
}: {
  clubId: string;
  products: Product[];
  movements: Movement[];
}) {
  const { showToast } = useToast();
  const [movements, setMovements] = useState(initialMovements);
  const [productFilter, setProductFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState<MovementType | "All">("All");

  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<MovementDraft>(() => emptyDraft(products));
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, startSaving] = useTransition();

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && modalOpen) setModalOpen(false);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [modalOpen]);

  const filtered = useMemo(() => {
    return movements
      .filter((m) => productFilter === "all" || m.productId === productFilter)
      .filter((m) => typeFilter === "All" || m.type === typeFilter);
  }, [movements, productFilter, typeFilter]);

  function openModal() {
    setDraft(emptyDraft(products));
    setSaveError(null);
    setModalOpen(true);
  }

  function handleSave() {
    setSaveError(null);
    const qtyNum = Number(draft.qty);
    if (!draft.productId) {
      setSaveError("Select a product");
      return;
    }
    if (!Number.isFinite(qtyNum) || qtyNum === 0) {
      setSaveError("Enter a valid, non-zero quantity");
      return;
    }
    startSaving(async () => {
      const result = await createMovementAction(clubId, {
        productId: draft.productId,
        type: draft.type,
        qty: qtyNum,
        cost: draft.cost === "" ? null : Number(draft.cost),
        batch: draft.batch || null,
        expiry: draft.expiry || null,
      });
      if (!result.ok) {
        setSaveError(result.error);
        return;
      }
      setMovements((prev) => [result.movement, ...prev]);
      showToast(
        `${result.movement.type} logged · ${result.movement.productName} stock now ${result.newStock}`,
      );
      setModalOpen(false);
    });
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <select
          value={productFilter}
          onChange={(e) => setProductFilter(e.target.value)}
          aria-label="Filter by product"
          className="rounded-[9px] border border-input bg-card px-3 py-[9px] text-[13px]"
        >
          <option value="all">All products</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="flex flex-wrap gap-[7px]">
          {TYPE_FILTERS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTypeFilter(t)}
              className="rounded-[8px] border px-3 py-[7px] text-[12.5px] font-medium"
              style={
                typeFilter === t
                  ? { background: "var(--primary)", borderColor: "var(--primary)", color: "#fff" }
                  : { background: "var(--card)", borderColor: "var(--border)", color: "#4a4e45" }
              }
            >
              {t === "All" ? "All types" : t}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={openModal}
          disabled={products.length === 0}
          title={products.length === 0 ? "Add a product first" : undefined}
          className="ml-auto rounded-[9px] px-[15px] py-[9px] text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#e4e1d7] disabled:text-[#a29c8c]"
          style={products.length > 0 ? { background: "var(--primary)" } : undefined}
        >
          + Log movement
        </button>
      </div>

      <div className="mb-3.5 flex items-start gap-2 rounded-[10px] border border-border bg-muted px-[13px] py-[9px] text-[12px] leading-[1.5] text-[#7c7f74]">
        <span className="flex-none text-[13px]">🔒</span>
        <span>
          Movements are an immutable audit trail — entries can&apos;t be edited or deleted. Correct mistakes
          by appending an ADJUSTMENT or WASTE.
        </span>
      </div>

      <div className="rounded-card border border-border bg-card">
        {movements.length === 0 ? (
          <div className="px-6 py-16 text-center text-[13.5px] text-[#6b6f66]">
            No movements yet — log your first inventory movement to get started.
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-16 text-center text-[13.5px] text-[#6b6f66]">
            No movements match your filters.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[110px_2fr_90px_90px_1fr_140px_100px] gap-3 border-b border-border bg-muted px-[18px] py-3 text-[11px] font-semibold uppercase tracking-[.05em] text-[#8a8e83]">
              <div>Type</div>
              <div>Product</div>
              <div>Qty</div>
              <div>Cost R</div>
              <div>Batch / expiry</div>
              <div>Staff</div>
              <div>Date</div>
            </div>
            {filtered.map((m) => (
              <div
                key={m.id}
                className="grid grid-cols-[110px_2fr_90px_90px_1fr_140px_100px] items-center gap-3 border-b border-[#f4f2ea] px-[18px] py-3 last:border-b-0"
              >
                <div>
                  <span
                    className="rounded-[5px] px-2 py-[3px] font-mono text-[10.5px] font-semibold"
                    style={TYPE_TAG_STYLE[m.type]}
                  >
                    {m.type}
                  </span>
                </div>
                <div className="truncate text-[13px] font-medium">{m.productName}</div>
                <div
                  className={
                    "font-mono text-[13px] font-semibold " +
                    (m.qty >= 0 ? "text-primary" : "text-destructive")
                  }
                >
                  {formatQty(m.qty, productById.get(m.productId)?.unit ?? "")}
                </div>
                <div className="font-mono text-[13px] text-[#6b6f66]">
                  {m.cost === null ? "—" : `R${m.cost}`}
                </div>
                <div className="truncate font-mono text-[11.5px] text-[#8a8e83]">
                  {m.batch
                    ? m.expiry
                      ? `${m.batch} · exp ${m.expiry}`
                      : m.batch
                    : m.expiry
                      ? `exp ${m.expiry}`
                      : "—"}
                </div>
                <div className="truncate text-[12px] text-[#6b6f66]">{m.staffEmail ?? "—"}</div>
                <div className="text-[11px] text-[#9a9e93]">
                  {new Date(m.createdAt).toLocaleDateString("en-ZA", { day: "2-digit", month: "short" })}
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {modalOpen && (
        <div
          role="presentation"
          onClick={() => setModalOpen(false)}
          className="fixed inset-0 z-[70] flex items-center justify-center bg-[rgba(22,26,21,.45)] p-6"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Log inventory movement"
            onClick={(e) => e.stopPropagation()}
            className="w-[480px] max-w-full rounded-2xl bg-card shadow-2xl"
          >
            <div className="flex items-center border-b border-[#eeece4] px-[22px] py-[18px]">
              <div className="font-heading text-lg font-bold">Log inventory movement</div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="ml-auto text-xl text-[#9a9e93]"
              >
                ×
              </button>
            </div>
            <div className="p-[22px]">
              <div className="mb-3.5">
                <label htmlFor="movementProduct" className="mb-1 block text-[11px] text-[#8a8e83]">
                  Product
                </label>
                <select
                  id="movementProduct"
                  value={draft.productId}
                  onChange={(e) => setDraft((prev) => ({ ...prev, productId: e.target.value }))}
                  className="w-full rounded-[9px] border border-input bg-card px-3 py-2.5 text-[13px]"
                >
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="mb-1.5 grid grid-cols-2 gap-3.5">
                <div>
                  <label htmlFor="movementType" className="mb-1 block text-[11px] text-[#8a8e83]">
                    Type
                  </label>
                  <select
                    id="movementType"
                    value={draft.type}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, type: e.target.value as LoggableMovementType }))
                    }
                    className="w-full rounded-[9px] border border-input bg-card px-3 py-2.5 text-[13px]"
                  >
                    {LOGGABLE_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="movementQty" className="mb-1 block text-[11px] text-[#8a8e83]">
                    Quantity
                  </label>
                  <input
                    id="movementQty"
                    inputMode="decimal"
                    value={draft.qty}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, qty: e.target.value.replace(/[^0-9.-]/g, "") }))
                    }
                    placeholder="e.g. 100 or -4"
                    className="w-full rounded-[9px] border border-input px-3 py-2.5 font-mono text-[13px]"
                  />
                </div>
              </div>
              <div className="mb-3.5 text-[11.5px] text-[#8a6d3b]">{hintForType(draft.type)}</div>
              <div className="mb-4 grid grid-cols-3 gap-3.5">
                <div>
                  <label htmlFor="movementCost" className="mb-1 block text-[11px] text-[#8a8e83]">
                    Cost R
                  </label>
                  <input
                    id="movementCost"
                    inputMode="decimal"
                    value={draft.cost}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, cost: e.target.value.replace(/[^0-9.]/g, "") }))
                    }
                    placeholder="opt."
                    className="w-full rounded-[9px] border border-input px-3 py-2.5 font-mono text-[13px]"
                  />
                </div>
                <div>
                  <label htmlFor="movementBatch" className="mb-1 block text-[11px] text-[#8a8e83]">
                    Batch #
                  </label>
                  <input
                    id="movementBatch"
                    value={draft.batch}
                    onChange={(e) => setDraft((prev) => ({ ...prev, batch: e.target.value }))}
                    placeholder="opt."
                    className="w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px]"
                  />
                </div>
                <div>
                  <label htmlFor="movementExpiry" className="mb-1 block text-[11px] text-[#8a8e83]">
                    Expiry
                  </label>
                  <input
                    id="movementExpiry"
                    type="date"
                    value={draft.expiry}
                    onChange={(e) => setDraft((prev) => ({ ...prev, expiry: e.target.value }))}
                    className="w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px]"
                  />
                </div>
              </div>
              {saveError && <p className="mb-3 text-[12.5px] text-destructive">{saveError}</p>}
              <div className="flex justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="rounded-[9px] border border-input bg-muted px-[18px] py-2.5 text-[13px] text-[#4a4e45]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={isSaving}
                  className="rounded-[9px] px-5 py-2.5 text-[13px] font-semibold text-white"
                  style={{ background: "var(--primary)" }}
                >
                  {isSaving ? "Posting…" : "Post movement"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Create the page**

Create `src/app/[clubSlug]/inventory/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import { getProducts } from "@/lib/products";
import { getMovements } from "@/lib/inventory";
import { InventoryHeader } from "./inventory-header";
import { InventoryTable } from "./inventory-table";

export default async function InventoryPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const supabase = await createClient();
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();

  const [products, movements] = await Promise.all([
    getProducts(supabase, access.clubId),
    getMovements(supabase, access.clubId),
  ]);

  return (
    <>
      <InventoryHeader />
      <InventoryTable clubId={access.clubId} products={products} movements={movements} />
    </>
  );
}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Build**

Run: `pnpm build`
Expected: succeeds, route table includes `/[clubSlug]/inventory`.

- [ ] **Step 7: Manual smoke test**

Use an isolated throwaway test club + throwaway admin user via the service-role key (`createAdminClient` from `src/lib/supabase/admin.ts`) — NOT the real shared `demo` club, per established precedent. Sign in, load `/inventory`, and confirm: (a) the fixture product's seeded PURCHASE movement renders with qty "+100g" (or the appropriate unit suffix) and the fixture admin's email in the Staff column; (b) logging a new PURCHASE movement via the modal adds it to the top of the list and shows a toast with the updated stock; (c) the product/type filters correctly narrow the list. Delete the throwaway club/user and any created rows immediately after, and verify deletion via a follow-up query.

- [ ] **Step 8: Commit**

```bash
git add src/app/\[clubSlug\]/inventory/page.tsx src/app/\[clubSlug\]/inventory/inventory-header.tsx src/app/\[clubSlug\]/inventory/inventory-table.tsx src/app/\[clubSlug\]/inventory/actions.ts
git commit -m "Build the Inventory screen (filtered ledger, log-movement modal)"
```

---

## Self-Review Notes

- **Spec coverage:** the `staff_email` snapshot decision (Task 1), sign-normalization + defense-in-depth checks (Task 2), filtered ledger + modal + immutable-audit notice (Task 3) — every section of `docs/superpowers/specs/2026-07-29-inventory-design.md` maps to a task.
- **Type consistency checked:** `Movement`/`MovementType`/`LoggableMovementType`/`CreateMovementInput` field names match exactly between Task 2's implementation, Task 2's tests, and Task 3's consumption (`m.qty`, `m.type`, `m.productName`, `m.staffEmail`, `result.movement`/`result.newStock`). `Product` field names (`p.id`, `p.name`, `p.unit`) confirmed against the actual current `src/lib/products.ts` — no drift.
- **No placeholders:** every step has complete, runnable code.
- **Cross-fixture verification:** `tests/rls/fixtures.ts`'s `SeededClub` confirmed (by direct read) to already expose `productId` and `inventoryMoveId` — Task 2's tests don't invent new fixture fields.
