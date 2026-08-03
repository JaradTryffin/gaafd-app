# Role-Based Access Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict staff-role club members to day-to-day operational screens (Dispensing, Members, Inventory, Donations, and their own Till clock-in/out) while admins keep full access — enforced server-side, not just hidden in the UI.

**Architecture:** Two tasks. Task 1 builds the actual security boundary: a new `assertClubAdmin` helper wired into the 7 existing mutation functions that should be admin-only, plus tests proving staff is rejected and admin still works. Task 2 builds the UX layer on top of that boundary: sidebar nav filtering, page-level redirects/`notFound()` gates, and a new staff-only Till view. Task 2 depends on Task 1 being merged first — its UI changes are safe to ship because the server-side checks already back them up.

**Tech Stack:** Next.js App Router, TypeScript, Supabase JS client, Vitest.

## Global Constraints

- This plan explicitly **modifies** `src/lib/products.ts`, `src/lib/contracts.ts`, `src/lib/till.ts`, and `src/components/app-shell/sidebar.tsx` — unlike prior plans' "reuse exactly as-is" instruction, modifying these is this feature's entire purpose.
- Reuse `src/lib/auth/club-access.ts`'s `resolveClubAccess` and `src/lib/club-context.tsx`'s `useClub` exactly as they exist — both already expose `role`, neither needs modification.
- No PostgREST relation embedding anywhere.
- No shadcn/`@base-ui/react` components — hand-rolled Tailwind, matching every prior screen.
- Every labeled form field needs `htmlFor`/`id` pairing.
- pnpm exclusively, Node via `.nvmrc` (run `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use` before any command — fall back to `node_modules/.bin/tsc`/`node_modules/.bin/next`/`node_modules/.bin/vitest` directly if this environment's pnpm/corepack shim still breaks).
- Commit messages plain, imperative. Work on branch `master` directly (standing consent from all prior phases).
- `Shift`/`Workstation`/`BusinessDay` types (`src/lib/till.ts`) and `ClubAccess`/`role: "staff"|"admin"` (`src/lib/auth/club-access.ts`) used in this plan are confirmed against the actual current files — no drift.

---

### Task 1: Server-side authorization boundary

**Files:**
- Create: `src/lib/auth/require-role.ts`
- Modify: `src/lib/products.ts` (add `assertClubAdmin` call to `createProduct`, `updateProduct`, `deleteOrDeactivateProduct`)
- Modify: `src/lib/contracts.ts` (add `assertClubAdmin` call to `saveContractTemplate`)
- Modify: `src/lib/till.ts` (add `assertClubAdmin` call to `openBusinessDay`, `closeBusinessDay`, `createWorkstation`)
- Test: `tests/products.test.ts`, `tests/contracts.test.ts`, `tests/till.test.ts` (add staff-rejection cases to each)

**Interfaces:**
- Produces: `assertClubAdmin(supabase: SupabaseClient, clubId: string): Promise<void>` — throws `Error("Admin access required")` if the caller isn't an admin in that club, throws `Error("Not signed in")` if unauthenticated. Consumed by Task 2's page-level gates is NOT needed (Task 2 uses `access.role` directly from `resolveClubAccess`, which already exists) — this function is consumed only by the 7 mutation functions in this task.

- [ ] **Step 1: Write `src/lib/auth/require-role.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

export async function assertClubAdmin(supabase: SupabaseClient, clubId: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const { data: membership, error } = await supabase
    .from("club_users")
    .select("role")
    .eq("club_id", clubId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) throw error;
  if (!membership || membership.role !== "admin") {
    throw new Error("Admin access required");
  }
}
```

- [ ] **Step 2: Wire it into `src/lib/products.ts`**

Add the import at the top of the file (alongside the existing imports):

```ts
import { assertClubAdmin } from "@/lib/auth/require-role";
```

Add `await assertClubAdmin(supabase, clubId);` as the first line inside each of these three function bodies (before any existing logic):

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
```

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
```

```ts
export async function deleteOrDeactivateProduct(
  supabase: SupabaseClient,
  clubId: string,
  productId: string,
): Promise<DeleteOrDeactivateResult> {
  await assertClubAdmin(supabase, clubId);
  const hasHistory = await hasProductHistory(supabase, clubId, productId);
```

Do not add the check to `getProducts` or `hasProductHistory` — both are reads, `getProducts` is used by staff's Dispensing screen.

- [ ] **Step 3: Wire it into `src/lib/contracts.ts`**

Add the import, then add `await assertClubAdmin(supabase, clubId);` as the first line of `saveContractTemplate` only:

```ts
export async function saveContractTemplate(
  supabase: SupabaseClient,
  clubId: string,
  input: { title: string; subtitle: string; consent: string; clauses: ContractClause[] },
): Promise<ContractTemplate> {
  await assertClubAdmin(supabase, clubId);
  const { data: existing } = await supabase
    .from("contract_templates")
    .select("version")
```

Do not add a separate check to `resetContractTemplate` — it already calls `saveContractTemplate` internally, so it inherits the check for free. Do not add the check to `getOrCreateContractTemplate` or `signContract` — both are needed by staff (contract reads and the member-signing flow).

- [ ] **Step 4: Wire it into `src/lib/till.ts`**

Add the import, then add `await assertClubAdmin(supabase, clubId);` as the first line of `openBusinessDay`, `closeBusinessDay`, and `createWorkstation`:

```ts
export async function openBusinessDay(
  supabase: SupabaseClient,
  clubId: string,
  initialFloat: number,
): Promise<BusinessDay> {
  await assertClubAdmin(supabase, clubId);
  const {
    data: { user },
  } = await supabase.auth.getUser();
```

```ts
export async function createWorkstation(
  supabase: SupabaseClient,
  clubId: string,
  name: string,
): Promise<Workstation> {
  await assertClubAdmin(supabase, clubId);
  const { data, error } = await supabase
    .from("workstations")
```

```ts
export async function closeBusinessDay(
  supabase: SupabaseClient,
  clubId: string,
  businessDayId: string,
): Promise<BusinessDay> {
  await assertClubAdmin(supabase, clubId);
  const {
    data: { user },
  } = await supabase.auth.getUser();
```

Do not add the check to `clockIn`, `clockOut`, or any of the `get*` read functions — staff needs all of those.

- [ ] **Step 5: Add staff-rejection tests to `tests/products.test.ts`**

Add a locally-seeded `role: 'staff'` user (mirroring `tests/till.test.ts`'s existing precedent) and rejection tests. Add these imports at the top, alongside the existing ones:

```ts
import { createAdminClient } from "@/lib/supabase/admin";
```

(This import already exists in the file — skip if already present; only add what's missing.) Add to the top-level `let`/`beforeAll`/`afterAll` block:

```ts
let staffClient: SupabaseClient;
let staffUserId: string;
const STAFF_PASSWORD = "Test-Password-123!";
```

Inside `beforeAll`, after the existing `clubAClient`/`clubBClient` sign-ins:

```ts
  const admin = createAdminClient();
  const staffEmail = `products-staff-${crypto.randomUUID().slice(0, 8)}@example.test`;
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
```

Inside `afterAll`, before the existing `cleanupTenants(data)` call:

```ts
  if (staffUserId) {
    await admin.auth.admin.deleteUser(staffUserId);
  }
```

(Note: `afterAll` already declares `const admin = createAdminClient();` at its top — reuse that binding, don't redeclare.)

Add a new `describe` block:

```ts
describe("role-based access", () => {
  it("rejects a staff-role user calling createProduct/updateProduct/deleteOrDeactivateProduct, but admin still succeeds", async () => {
    await expect(
      createProduct(staffClient, data.clubA.clubId, {
        name: "Staff Attempt",
        category: "Flower",
        unit: "per 1g",
        tokenPrice: 10,
        sellPrice: 15,
        flags: [],
      }),
    ).rejects.toThrow("Admin access required");

    const product = await createProduct(clubAClient, data.clubA.clubId, {
      name: "Admin Created Product",
      category: "Flower",
      unit: "per 1g",
      tokenPrice: 10,
      sellPrice: 15,
      flags: [],
    });
    cleanupProductIds.push(product.id);

    await expect(
      updateProduct(staffClient, data.clubA.clubId, product.id, {
        name: "Staff Edited",
        category: "Flower",
        unit: "per 1g",
        tokenPrice: 20,
        sellPrice: 30,
        flags: [],
      }),
    ).rejects.toThrow("Admin access required");

    const updated = await updateProduct(clubAClient, data.clubA.clubId, product.id, {
      name: "Admin Edited",
      category: "Flower",
      unit: "per 1g",
      tokenPrice: 20,
      sellPrice: 30,
      flags: [],
    });
    expect(updated.name).toBe("Admin Edited");

    await expect(deleteOrDeactivateProduct(staffClient, data.clubA.clubId, product.id)).rejects.toThrow(
      "Admin access required",
    );

    const result = await deleteOrDeactivateProduct(clubAClient, data.clubA.clubId, product.id);
    expect(result.action).toBe("deleted");
  });
});
```

- [ ] **Step 6: Add staff-rejection test to `tests/contracts.test.ts`**

`createAdminClient` is already imported in this file (top of file, alongside `seedTenants`/`cleanupTenants`/`signInAs`) — do not add a duplicate import.

Add the top-level declarations (same as Step 5, substituting the email prefix):

```ts
let staffClient: SupabaseClient;
let staffUserId: string;
const STAFF_PASSWORD = "Test-Password-123!";
```

Inside `beforeAll`, after the existing `clubAClient` sign-in, add the same seeding block as Step 5 but with `contracts-staff-` as the email prefix instead of `products-staff-`:

```ts
  const admin = createAdminClient();
  const staffEmail = `contracts-staff-${crypto.randomUUID().slice(0, 8)}@example.test`;
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
```

This file's `afterAll` currently only calls `cleanupTenants(data)` — it does NOT already declare an `admin` binding (unlike `products.test.ts`'s `afterAll`, which does). Replace the existing `afterAll` body:

```ts
afterAll(async () => {
  if (data) {
    await cleanupTenants(data);
  }
}, 30000);
```

with:

```ts
afterAll(async () => {
  if (staffUserId) {
    const admin = createAdminClient();
    await admin.auth.admin.deleteUser(staffUserId);
  }
  if (data) {
    await cleanupTenants(data);
  }
}, 30000);
```

Add a new `describe` block:

```ts
describe("role-based access", () => {
  it("rejects a staff-role user calling saveContractTemplate, but admin still succeeds", async () => {
    await expect(
      saveContractTemplate(staffClient, data.clubA.clubId, {
        title: "Staff Attempt",
        subtitle: "Should not save",
        consent: "N/A",
        clauses: [],
      }),
    ).rejects.toThrow("Admin access required");

    const saved = await saveContractTemplate(clubAClient, data.clubA.clubId, {
      title: "Admin Saved Title",
      subtitle: "Admin subtitle",
      consent: "Admin consent",
      clauses: [{ heading: "Intro", body: "Admin clause body" }],
    });
    expect(saved.title).toBe("Admin Saved Title");
  });
});
```

- [ ] **Step 7: Add staff-rejection tests to `tests/till.test.ts`**

This file already has a locally-seeded `staffClient`/`staffUserId` from its existing force-close test — reuse it, do not seed a second staff user. Add a new `describe` block:

```ts
describe("role-based access", () => {
  it("rejects a staff-role user calling openBusinessDay/createWorkstation/closeBusinessDay, but admin still succeeds", async () => {
    await expect(openBusinessDay(staffClient, data.clubA.clubId, 500)).rejects.toThrow(
      "Admin access required",
    );

    const day = await openBusinessDay(clubAClient, data.clubA.clubId, 500);

    await expect(
      createWorkstation(staffClient, data.clubA.clubId, "Staff Attempt Workstation"),
    ).rejects.toThrow("Admin access required");

    const workstation = await createWorkstation(clubAClient, data.clubA.clubId, "Admin Workstation");
    expect(workstation.name).toBe("Admin Workstation");

    await expect(closeBusinessDay(staffClient, data.clubA.clubId, day.id)).rejects.toThrow(
      "Admin access required",
    );

    const closedDay = await closeBusinessDay(clubAClient, data.clubA.clubId, day.id);
    expect(closedDay.status).toBe("closed");
  });
});
```

This test opens and closes its own business day (no shifts involved, so `closeBusinessDay` succeeds immediately) — it runs independently of the file's existing lifecycle test as long as no other open business day exists for club A when it runs. Since `tests/till.test.ts`'s existing lifecycle test already opens and closes its own day earlier in the file, and vitest runs `describe` blocks in file order by default, place this new `describe` block after the existing ones so club A's business day is guaranteed closed by the time this test opens a new one.

- [ ] **Step 8: Run all three affected test files**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use && node_modules/.bin/vitest run tests/products.test.ts tests/contracts.test.ts tests/till.test.ts`
Expected: all tests pass, including the 3 new `describe("role-based access", ...)` blocks.

- [ ] **Step 9: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/lib/auth/require-role.ts src/lib/products.ts src/lib/contracts.ts src/lib/till.ts tests/products.test.ts tests/contracts.test.ts tests/till.test.ts
git commit -m "Add server-side admin-only authorization for products, contracts, and till management"
```

---

### Task 2: UI enforcement — nav filtering, page gates, staff Till view

**Files:**
- Modify: `src/components/app-shell/sidebar.tsx`
- Modify: `src/app/[clubSlug]/page.tsx` (Dashboard)
- Modify: `src/app/[clubSlug]/products/page.tsx`
- Modify: `src/app/[clubSlug]/settings/contract/page.tsx`
- Modify: `src/app/[clubSlug]/till/page.tsx`
- Create: `src/app/[clubSlug]/till/staff-clock-panel.tsx`

**Interfaces:**
- Consumes: Task 1's server-side checks as the real backstop (this task's changes are UX only — hiding/redirecting — and are safe to ship because Task 1 already rejects the underlying mutations regardless of what the UI shows). Consumes `ClubAccess.role` (`src/lib/auth/club-access.ts`, unchanged), `useClub().role` (`src/lib/club-context.tsx`, unchanged), and `src/lib/till.ts`'s existing `Shift`/`Workstation` types and `clockInAction`/`clockOutAction` (`src/app/[clubSlug]/till/actions.ts`, unchanged — both remain ungated per Task 1).

- [ ] **Step 1: Filter sidebar nav by role**

In `src/components/app-shell/sidebar.tsx`, add `adminOnly: true` to the `dashboard`, `products`, and `contract` entries in `NAV_GROUPS`:

```ts
const NAV_GROUPS = [
  {
    label: "Operations",
    items: [
      { key: "dashboard", label: "Dashboard", path: "", dot: "var(--sidebar-accent-dot)", adminOnly: true },
      { key: "dispense", label: "Dispensing", path: "/dispense", dot: "var(--badge-warn-fg)" },
      { key: "members", label: "Members", path: "/members", dot: "var(--primary)" },
      { key: "products", label: "Products", path: "/products", dot: "var(--tenant-accent-2)", adminOnly: true },
      { key: "inventory", label: "Inventory", path: "/inventory", dot: "var(--tenant-accent-3)" },
    ],
  },
  {
    label: "Accounting",
    items: [
      { key: "donations", label: "Donations", path: "/donations", dot: "var(--tenant-accent-5)" },
      { key: "till", label: "Till & shifts", path: "/till", dot: "var(--tenant-accent-4)" },
    ],
  },
  {
    label: "Settings",
    items: [
      {
        key: "contract",
        label: "Contract template",
        path: "/settings/contract",
        dot: "var(--text-muted-2)",
        adminOnly: true,
      },
    ],
  },
] as const;
```

Then filter each group's rendered items in the `nav` block — replace:

```tsx
            {group.items.map((item) => {
```

with:

```tsx
            {group.items
              .filter((item) => !("adminOnly" in item && item.adminOnly) || club.role === "admin")
              .map((item) => {
```

and correspondingly close the added `.filter(...)` call's parenthesis — the existing `.map((item) => { ... })` block's closing `)}` (currently at the end of the `group.items.map(...)` expression) needs one more closing `)` to match the added `.filter(...).map(...)` chain. Concretely, the full block becomes:

```tsx
            {group.items
              .filter((item) => !("adminOnly" in item && item.adminOnly) || club.role === "admin")
              .map((item) => {
                const href = `/${club.slug}${item.path}`;
                const active = item.path === "" ? pathname === href : pathname.startsWith(href);
                return (
                  <Link
                    key={item.key}
                    href={href}
                    className="my-px flex items-center gap-2.5 rounded-r-lg border-l-2 px-[11px] py-[9px] text-[13px]"
                    style={{
                      background: active ? "var(--sidebar-surface)" : "transparent",
                      borderLeftColor: active ? "var(--sidebar-accent-dot)" : "transparent",
                      color: active ? "#eef1ea" : "#a8afa1",
                    }}
                  >
                    <span className="h-1.5 w-1.5 flex-none rounded-sm" style={{ background: item.dot }} />
                    <span className="flex-1">{item.label}</span>
                  </Link>
                );
              })}
```

- [ ] **Step 2: Gate the Dashboard page**

In `src/app/[clubSlug]/page.tsx`, add `redirect` to the existing `next/navigation` import and add the role check right after the existing `if (!access) notFound();` line:

```tsx
import { notFound, redirect } from "next/navigation";
```

```tsx
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();
  if (access.role !== "admin") redirect(`/${clubSlug}/dispense`);
```

- [ ] **Step 3: Gate the Products page**

In `src/app/[clubSlug]/products/page.tsx`, add the role check right after the existing `if (!access) notFound();` line:

```tsx
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();
  if (access.role !== "admin") notFound();
```

- [ ] **Step 4: Gate the Contract template page**

In `src/app/[clubSlug]/settings/contract/page.tsx`, add the same check:

```tsx
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();
  if (access.role !== "admin") notFound();
```

- [ ] **Step 5: Write `src/app/[clubSlug]/till/staff-clock-panel.tsx`**

```tsx
"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/lib/toast-context";
import { clockInAction, clockOutAction } from "./actions";
import type { Shift, Workstation } from "@/lib/till";

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" });
}

export function StaffClockPanel({
  clubId,
  isDayOpen,
  workstations,
  myShift: initialMyShift,
}: {
  clubId: string;
  isDayOpen: boolean;
  workstations: Workstation[];
  myShift: Shift | null;
}) {
  const { showToast } = useToast();
  const [myShift, setMyShift] = useState(initialMyShift);
  const [workstationInput, setWorkstationInput] = useState("");
  const [cashOutInput, setCashOutInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleClockIn() {
    setError(null);
    startTransition(async () => {
      const result = await clockInAction(clubId, workstationInput || null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMyShift(result.shift);
      showToast("Clocked in");
    });
  }

  function handleClockOut() {
    if (!myShift) return;
    setError(null);
    const amount = Number(cashOutInput);
    if (!cashOutInput || Number.isNaN(amount) || amount < 0) {
      setError("Enter a valid cash-out amount");
      return;
    }
    startTransition(async () => {
      const result = await clockOutAction(myShift.id, amount, false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMyShift(null);
      setCashOutInput("");
      showToast("Clocked out");
    });
  }

  if (!isDayOpen) {
    return (
      <div className="flex min-h-[360px] items-center justify-center">
        <div className="w-full max-w-[380px] rounded-card border border-border bg-card p-6 text-center">
          <div className="mb-1 font-heading text-base font-semibold">No business day open</div>
          <p className="text-[12.5px] text-[#6b6f66]">
            Ask an admin to open today&apos;s business day before clocking in.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[360px] items-center justify-center">
      <div className="w-full max-w-[380px] rounded-card border border-border bg-card p-6">
        {myShift ? (
          <>
            <div className="mb-1 font-heading text-base font-semibold">
              Clocked in {timeLabel(myShift.clockIn)}
              {myShift.workstationName ? ` · ${myShift.workstationName}` : ""}
            </div>
            <p className="mb-4 text-[12.5px] text-[#6b6f66]">Enter your cash-out amount to clock out.</p>
            <label htmlFor="staffCashOut" className="mb-1 block text-left text-[11px] text-[#8a8e83]">
              Cash out (R)
            </label>
            <input
              id="staffCashOut"
              inputMode="numeric"
              value={cashOutInput}
              onChange={(e) => setCashOutInput(e.target.value.replace(/[^0-9]/g, ""))}
              className="mb-3 w-full rounded-[9px] border border-input px-3 py-3 text-center font-mono text-xl font-semibold"
            />
            {error && <p className="mb-3 text-[12.5px] text-destructive">{error}</p>}
            <button
              type="button"
              onClick={handleClockOut}
              disabled={isPending}
              className="w-full rounded-[9px] py-3 text-[14px] font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#e4e1d7] disabled:text-[#a29c8c]"
              style={!isPending ? { background: "var(--primary)" } : undefined}
            >
              {isPending ? "Clocking out…" : "Clock out"}
            </button>
          </>
        ) : (
          <>
            <div className="mb-1 font-heading text-base font-semibold">You are not clocked in</div>
            <p className="mb-4 text-[12.5px] text-[#6b6f66]">Select a workstation (optional) and clock in.</p>
            <label htmlFor="staffWorkstation" className="mb-1 block text-left text-[11px] text-[#8a8e83]">
              Workstation
            </label>
            <select
              id="staffWorkstation"
              value={workstationInput}
              onChange={(e) => setWorkstationInput(e.target.value)}
              className="mb-3 w-full rounded-[9px] border border-input bg-card px-3 py-2.5 text-[13px]"
            >
              <option value="">No workstation</option>
              {workstations.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            {error && <p className="mb-3 text-[12.5px] text-destructive">{error}</p>}
            <button
              type="button"
              onClick={handleClockIn}
              disabled={isPending}
              className="w-full rounded-[9px] py-3 text-[14px] font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#e4e1d7] disabled:text-[#a29c8c]"
              style={!isPending ? { background: "var(--primary)" } : undefined}
            >
              {isPending ? "Clocking in…" : "Clock in"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Branch `src/app/[clubSlug]/till/page.tsx` on role**

Replace the full file with:

```tsx
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import { getOpenBusinessDay, getWorkstations, getShiftsForDay, getCashDonationsToday } from "@/lib/till";
import { TillHeader } from "./till-header";
import { TillPanel } from "./till-panel";
import { StaffClockPanel } from "./staff-clock-panel";

export default async function TillPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const supabase = await createClient();
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const businessDay = await getOpenBusinessDay(supabase, access.clubId);

  if (access.role !== "admin") {
    const workstations = await getWorkstations(supabase, access.clubId);
    const shifts = businessDay ? await getShiftsForDay(supabase, access.clubId, businessDay.id) : [];
    const myShift = shifts.find((s) => s.staffEmail === user?.email && s.status === "open") ?? null;

    return (
      <>
        <TillHeader />
        <StaffClockPanel
          clubId={access.clubId}
          isDayOpen={businessDay !== null}
          workstations={workstations}
          myShift={myShift}
        />
      </>
    );
  }

  const [workstations, shifts, cashDonationsToday] = await Promise.all([
    getWorkstations(supabase, access.clubId),
    businessDay ? getShiftsForDay(supabase, access.clubId, businessDay.id) : Promise.resolve([]),
    getCashDonationsToday(supabase, access.clubId),
  ]);

  return (
    <>
      <TillHeader />
      <TillPanel
        clubId={access.clubId}
        currentUserEmail={user?.email ?? ""}
        businessDay={businessDay}
        workstations={workstations}
        shifts={shifts}
        cashDonationsToday={cashDonationsToday}
      />
    </>
  );
}
```

- [ ] **Step 7: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 8: Build**

Run: `node_modules/.bin/next build`
Expected: clean build, no route table regressions.

- [ ] **Step 9: Manual smoke test**

Using the demo club (`admin@gaafd.test` / `SmokeTest2026!`, slug `demo`): confirm all 8 nav items visible, all pages load, Till shows the full admin dashboard.

Create a staff-role test login for the demo club (via a one-off script calling `inviteStaffToClub`, or a direct `club_users` insert with `role: 'staff'` against an existing or new auth user) and sign in as them. Confirm:
- Sidebar shows only Dispensing, Members, Inventory, Donations, Till & shifts (no Dashboard, Products, or Contract template).
- Navigating to `/demo` redirects to `/demo/dispense`.
- Navigating directly to `/demo/products` and `/demo/settings/contract` both 404.
- `/demo/till` shows only the clock-in/out card (no KPIs, no shifts table, no workstations panel) — if a business day is open, clocking in/out works; if not, the "ask an admin" message shows.

- [ ] **Step 10: Commit**

```bash
git add src/components/app-shell/sidebar.tsx "src/app/[clubSlug]/page.tsx" "src/app/[clubSlug]/products/page.tsx" "src/app/[clubSlug]/settings/contract/page.tsx" "src/app/[clubSlug]/till/page.tsx" "src/app/[clubSlug]/till/staff-clock-panel.tsx"
git commit -m "Restrict staff nav/pages to operational screens and add staff-only Till clock view"
```
