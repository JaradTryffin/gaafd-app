# GaafD Phase 3 — App Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the sidebar (workspace switcher + grouped nav + user footer), page header, and toast system — the chrome every phase-5 screen renders inside — and wire it into the club-scoped route tree without touching phase 2's authorization logic.

**Architecture:** Two client-side context providers (toast, page header) sit alongside phase 2's existing `ClubProvider`, all instantiated once in `[clubSlug]/layout.tsx`. The Sidebar is a client component fed server-fetched data (the caller's clubs, their email) as props — it does no data fetching itself. Nav items point at their eventual phase-5 routes now; most 404 until phase 5 builds them, which is expected during incremental construction.

**Tech Stack:** Next.js Server/Client Components, React Context, Tailwind v4 (`@theme`-mapped utilities already set up in phase 0's `globals.css`).

## Global Constraints

- Reuse exactly as-is, extend never replace: `src/lib/club-context.tsx` (`ClubProvider`/`useClub`), `src/lib/auth/actions.ts` (`signOut`), `src/lib/auth/club-access.ts` (`resolveClubAccess`, `resolvePlatformAccess`), and every authorization check already in `src/app/[clubSlug]/layout.tsx` — this plan only adds UI around what phase 2 already gates.
- Package manager: pnpm exclusively. Node 24.18.0 via `.nvmrc` (`export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use` before running anything).
- Commit messages: plain, imperative. Work on branch `master` directly (standing consent from phases 0-2).
- No component/DOM testing framework exists in this project (no React Testing Library/jsdom), and this plan doesn't add one. UI is verified via `tsc`/`build`/manual smoke test — matching how phase 2's login and placeholder pages were verified. Only the data-layer function (`listUserClubs`) gets a live Vitest suite, consistent with this project testing logic against the real Supabase project (ref `inlseklfbptgjketdnpe`) rather than mocking it.
- Design tokens must match `gaafd/README.md`'s token table and the already-committed `src/app/globals.css` exactly. The current `@theme`-mapped Tailwind utilities (confirmed from the live file) are: `bg-background`, `text-foreground`, `bg-card`, `bg-popover`, `bg-primary`/`text-primary`, `bg-secondary`, `bg-muted`/`text-muted-foreground`, `bg-accent`, `bg-destructive`, `border-border`, `border-input`, `ring-ring`, `bg-sidebar-bg`, `bg-sidebar-surface`, `border-sidebar-border-dark`, `text-sidebar-text`, `text-sidebar-text-muted`, `text-sidebar-accent-dot`, `bg-status-active-bg`/`text-status-active-fg`, `bg-status-inactive-bg`/`text-status-inactive-fg`, `rounded-card`, `font-sans` (IBM Plex Sans, body default), `font-mono` (IBM Plex Mono), `font-heading` (Bricolage Grotesque). Tokens with **no** mapping (use `bg-[var(--x)]` arbitrary syntax): `--link`, `--link-hover`, `--text-secondary`, `--text-muted-2`, `--text-muted-3`, `--border-2/3/4`, `--border-dashed`, `--disabled-button`, `--badge-warn-bg`/`--badge-warn-fg`, `--tenant-accent-1..5`. Never invent a new one-off hex where an existing token/mapping applies.

---

**Note on the Platform nav section:** the design reference's sidebar has a fourth nav group ("Platform") shown only when `isPlatformRole` — but that's an artifact of the reference prototype demoing every screen from one signed-in-as-platform session (the design handoff's README says this explicitly). In this app's real access model, a user inside `[clubSlug]/*` always has a `club_users` row (that's what got them past phase 2's gate) and therefore can never simultaneously be in `platform_users` — platform and club access are mutually exclusive by construction (phase 1's RLS design). So the club-scoped Sidebar never needs a Platform section or a "Manage all clubs" link; there is no real user for whom it would ever render. `/platform` remains its own separate area (phase 2's placeholder today, phase 5's real console later) with no sidebar of its own.

## File Structure

- `src/lib/toast-context.tsx` — `ToastProvider`, `useToast()` (Task 1).
- `src/app/globals.css` — modified, adds `gfToast`/`gfFade` keyframes (Task 1).
- `src/lib/page-header-context.tsx` — `PageHeaderProvider`, `usePageHeader()`, `usePageHeaderValue()` (Task 2).
- `src/components/app-shell/header.tsx` — `AppHeader` (Task 2).
- `src/lib/auth/club-access.ts` — modified, adds `ClubMembershipSummary`, `listUserClubs` (Task 3).
- `tests/auth/access.test.ts` — modified, adds `listUserClubs` tests (Task 3).
- `src/components/app-shell/sidebar.tsx` — `Sidebar` (Task 4).
- `src/app/[clubSlug]/layout.tsx` — modified, assembles the shell (Task 5).
- `src/app/[clubSlug]/page.tsx` — modified, becomes the Dashboard placeholder using the new header hook (Task 5).

---

### Task 1: Toast system

**Files:**
- Create: `src/lib/toast-context.tsx`
- Modify: `src/app/globals.css`

**Interfaces:**
- Consumes: `--primary`, `--destructive` CSS tokens (phase 0)
- Produces: `ToastProvider`, `useToast(): { showToast: (message: string, variant?: "success" | "error") => void }` — consumed by Task 5's layout (provider placement) and any future phase-5 screen action (save/delete/dispense confirmations)

- [ ] **Step 1: Add the toast keyframes**

Add to the end of `src/app/globals.css`:

```css
@keyframes gfFade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes gfToast {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

- [ ] **Step 2: Write the toast provider**

Create `src/lib/toast-context.tsx`:

```tsx
"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";

export type ToastVariant = "success" | "error";

type ToastState = {
  message: string;
  variant: ToastVariant;
} | null;

type ToastContextValue = {
  showToast: (message: string, variant?: ToastVariant) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_DURATION_MS = 2600;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastState>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string, variant: ToastVariant = "success") => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setToast({ message, variant });
    timeoutRef.current = setTimeout(() => setToast(null), TOAST_DURATION_MS);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toast && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-[80] flex -translate-x-1/2 items-center gap-2 rounded-[11px] px-5 py-3 text-[13.5px] font-medium text-white shadow-[0_12px_30px_rgba(0,0,0,.25)]"
          style={{
            background: toast.variant === "success" ? "var(--primary)" : "var(--destructive)",
            animation: "gfToast .3s ease",
          }}
        >
          <span className="text-[15px]">{toast.variant === "success" ? "✓" : "!"}</span>
          {toast.message}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}
```

- [ ] **Step 3: Verify**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use
cd /Users/user/Documents/projects/gaafd-app
pnpm exec tsc --noEmit
```

Expected: no errors. (This file isn't wired into any page yet — that's Task 5 — so `pnpm build` won't reference it until then; typecheck alone confirms it compiles.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/toast-context.tsx src/app/globals.css
git commit -m "Add toast system"
```

---

### Task 2: Page header system

**Files:**
- Create: `src/lib/page-header-context.tsx`
- Create: `src/components/app-shell/header.tsx`

**Interfaces:**
- Consumes: nothing new
- Produces: `PageHeaderProvider`, `usePageHeader(value: { title: string; subtitle?: string; actions?: React.ReactNode }): void`, `usePageHeaderValue(): { title: string; subtitle?: string; actions?: React.ReactNode }`, `AppHeader` component — consumed by Task 5's layout (provider + `AppHeader` placement) and Task 5's Dashboard placeholder (`usePageHeader` call); the `actions` slot is unused until phase 5

- [ ] **Step 1: Write the page header context**

Create `src/lib/page-header-context.tsx`:

```tsx
"use client";

import { createContext, useContext, useEffect, useState } from "react";

export type PageHeaderValue = {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
};

type PageHeaderContextValue = {
  header: PageHeaderValue;
  setHeader: (value: PageHeaderValue) => void;
};

const DEFAULT_HEADER: PageHeaderValue = { title: "" };

const PageHeaderContext = createContext<PageHeaderContextValue | null>(null);

export function PageHeaderProvider({ children }: { children: React.ReactNode }) {
  const [header, setHeader] = useState<PageHeaderValue>(DEFAULT_HEADER);
  return (
    <PageHeaderContext.Provider value={{ header, setHeader }}>
      {children}
    </PageHeaderContext.Provider>
  );
}

// Pages call this to set the shared header. Runs in an effect (not during
// render) so it doesn't trigger a state update in the provider while React
// is still rendering the tree that reads that same state.
export function usePageHeader(value: PageHeaderValue) {
  const ctx = useContext(PageHeaderContext);
  if (!ctx) {
    throw new Error("usePageHeader must be used within a PageHeaderProvider");
  }
  const { title, subtitle, actions } = value;
  useEffect(() => {
    ctx.setHeader({ title, subtitle, actions });
    // ctx.setHeader is stable across renders (from useState), but ESLint's
    // exhaustive-deps can't know that — omitting it here is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, subtitle, actions]);
}

export function usePageHeaderValue(): PageHeaderValue {
  const ctx = useContext(PageHeaderContext);
  if (!ctx) {
    throw new Error("usePageHeaderValue must be used within a PageHeaderProvider");
  }
  return ctx.header;
}
```

- [ ] **Step 2: Write the header component**

Create `src/components/app-shell/header.tsx`:

```tsx
"use client";

import { usePageHeaderValue } from "@/lib/page-header-context";

export function AppHeader() {
  const { title, subtitle, actions } = usePageHeaderValue();
  return (
    <header className="flex flex-none items-center gap-4 border-b border-border bg-[#fbfaf6] px-7 py-[18px]">
      <div className="min-w-0">
        <div className="font-heading text-[22px] font-bold leading-[1.1] tracking-[-0.02em]">
          {title}
        </div>
        {subtitle && <div className="mt-0.5 text-[12.5px] text-[#6b6f66]">{subtitle}</div>}
      </div>
      {actions && <div className="ml-auto flex items-center gap-2.5">{actions}</div>}
    </header>
  );
}
```

- [ ] **Step 3: Verify**

```bash
pnpm exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/page-header-context.tsx src/components/app-shell/header.tsx
git commit -m "Add page header system"
```

---

### Task 3: Club-switcher data layer

**Files:**
- Modify: `src/lib/auth/club-access.ts`
- Modify: `tests/auth/access.test.ts`

**Interfaces:**
- Consumes: nothing new (same `SupabaseClient` pattern as `resolveClubAccess`/`resolvePlatformAccess`, already in this file)
- Produces: `ClubMembershipSummary` type, `listUserClubs(supabase: SupabaseClient): Promise<ClubMembershipSummary[]>` — consumed by Task 5's layout, which passes the result to Task 4's `Sidebar`

- [ ] **Step 1: Add `listUserClubs` to the existing file**

Append to `src/lib/auth/club-access.ts` (after `resolvePlatformAccess`, keep everything else in the file unchanged):

```ts
export type ClubMembershipSummary = {
  clubId: string;
  slug: string;
  name: string;
  initials: string;
  accentColor: string;
  plan: string;
};

export async function listUserClubs(supabase: SupabaseClient): Promise<ClubMembershipSummary[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data: memberships } = await supabase.from("club_users").select("club_id");
  const clubIds = (memberships ?? []).map((m) => m.club_id);
  if (clubIds.length === 0) return [];

  const { data: clubs } = await supabase
    .from("clubs")
    .select("id, slug, name, initials, accent_color, plan")
    .in("id", clubIds);

  return (clubs ?? []).map((c) => ({
    clubId: c.id,
    slug: c.slug,
    name: c.name,
    initials: c.initials,
    accentColor: c.accent_color,
    plan: c.plan,
  }));
}
```

- [ ] **Step 2: Add tests to the existing test file**

Append to `tests/auth/access.test.ts` (after the existing `describe("resolvePlatformAccess", ...)` block; add `listUserClubs` to the existing `import { resolveClubAccess, resolvePlatformAccess } from "@/lib/auth/club-access";` line at the top so it reads `import { resolveClubAccess, resolvePlatformAccess, listUserClubs } from "@/lib/auth/club-access";`; also add `import { createAdminClient } from "@/lib/supabase/admin";` if not already imported in this file):

```ts
describe("listUserClubs", () => {
  it("returns exactly the caller's own club", async () => {
    const clubs = await listUserClubs(clubAClient);
    expect(clubs.map((c) => c.clubId)).toEqual([data.clubA.clubId]);
  });

  it("returns every club a multi-club owner belongs to", async () => {
    const admin = createAdminClient();
    const { error } = await admin.from("club_users").insert({
      club_id: data.clubB.clubId,
      user_id: data.clubA.adminUserId,
      role: "admin",
    });
    if (error) throw error;

    try {
      const clubs = await listUserClubs(clubAClient);
      expect(clubs.map((c) => c.clubId).sort()).toEqual(
        [data.clubA.clubId, data.clubB.clubId].sort(),
      );
    } finally {
      await admin
        .from("club_users")
        .delete()
        .eq("club_id", data.clubB.clubId)
        .eq("user_id", data.clubA.adminUserId);
    }
  });

  it("returns an empty array for a platform-only caller", async () => {
    const clubs = await listUserClubs(platformClient);
    expect(clubs).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it**

```bash
pnpm exec vitest run tests/auth/access.test.ts
```

Expected: all tests pass (the pre-existing `resolveClubAccess`/`resolvePlatformAccess` tests plus the 3 new `listUserClubs` tests). This hits the live Supabase project.

- [ ] **Step 4: Run the full suite**

```bash
pnpm test
```

Expected: everything passes except (if applicable) `tests/auth/invites.test.ts`'s two email-quota-limited happy-path tests, a known pre-existing environmental constraint unrelated to this task (documented in the project's progress ledger) — do not attempt to fix that here.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/club-access.ts tests/auth/access.test.ts
git commit -m "Add listUserClubs for the workspace switcher"
```

---

### Task 4: Sidebar component

**Files:**
- Create: `src/components/app-shell/sidebar.tsx`

**Interfaces:**
- Consumes: `useClub` (`src/lib/club-context.tsx`, phase 2), `signOut` (`src/lib/auth/actions.ts`, phase 2), `ClubMembershipSummary` (Task 3)
- Produces: `Sidebar({ clubs, userEmail }: { clubs: ClubMembershipSummary[]; userEmail: string })` — consumed by Task 5's layout

- [ ] **Step 1: Write the sidebar**

Create `src/components/app-shell/sidebar.tsx`:

```tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useClub } from "@/lib/club-context";
import { signOut } from "@/lib/auth/actions";
import type { ClubMembershipSummary } from "@/lib/auth/club-access";

const NAV_GROUPS = [
  {
    label: "Operations",
    items: [
      { key: "dashboard", label: "Dashboard", path: "", dot: "var(--sidebar-accent-dot)" },
      { key: "dispense", label: "Dispensing", path: "/dispense", dot: "var(--badge-warn-fg)" },
      { key: "members", label: "Members", path: "/members", dot: "var(--primary)" },
      { key: "products", label: "Products", path: "/products", dot: "var(--tenant-accent-2)" },
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
      },
    ],
  },
] as const;

export function Sidebar({
  clubs,
  userEmail,
}: {
  clubs: ClubMembershipSummary[];
  userEmail: string;
}) {
  const club = useClub();
  const pathname = usePathname();
  const [switcherOpen, setSwitcherOpen] = useState(false);

  return (
    <aside className="flex h-full w-[248px] flex-none flex-col bg-sidebar-bg text-sidebar-text">
      <div className="px-[18px] pb-3.5 pt-5">
        <div className="mb-4 flex items-center gap-2.5">
          <div className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-primary font-heading text-base font-bold text-white">
            G
          </div>
          <div className="font-heading text-[19px] font-bold tracking-[-0.02em] text-white">
            GaafD
          </div>
          <div className="ml-auto rounded-[5px] border border-sidebar-border-dark px-1.5 py-0.5 font-mono text-[10px] text-[#7f877a]">
            SaaS
          </div>
        </div>

        <div className="relative">
          <button
            type="button"
            onClick={() => setSwitcherOpen((open) => !open)}
            className="flex w-full items-center gap-2.5 rounded-[10px] border border-sidebar-border-dark bg-sidebar-surface px-[11px] py-[9px] text-left hover:bg-[#252c22]"
          >
            <div
              className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[7px] font-heading text-xs font-bold text-white"
              style={{ background: club.accentColor }}
            >
              {club.initials}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-semibold text-white">{club.name}</div>
            </div>
            <div className="text-[11px] text-[#8a9182]">▾</div>
          </button>

          {switcherOpen && (
            <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-40 rounded-[10px] border border-sidebar-border-dark bg-sidebar-surface p-1.5 shadow-[0_12px_30px_rgba(0,0,0,.4)]">
              {clubs.map((c) => (
                <Link
                  key={c.clubId}
                  href={`/${c.slug}`}
                  onClick={() => setSwitcherOpen(false)}
                  className="flex w-full items-center gap-2.5 rounded-[7px] px-[9px] py-2 text-left hover:bg-[#2a3126]"
                >
                  <div
                    className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-[6px] font-heading text-[10px] font-bold text-white"
                    style={{ background: c.accentColor }}
                  >
                    {c.initials}
                  </div>
                  <div className="min-w-0 flex-1 truncate text-xs font-medium text-[#e9ede6]">
                    {c.name}
                  </div>
                  {c.slug === club.slug && (
                    <span className="text-xs text-sidebar-accent-dot">●</span>
                  )}
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-1.5">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="px-2.5 pb-1.5 pt-2.5 text-[10px] uppercase tracking-[.09em] text-sidebar-text-muted">
              {group.label}
            </div>
            {group.items.map((item) => {
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
          </div>
        ))}
      </nav>

      <div className="flex items-center gap-2.5 border-t border-[#262c22] p-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-white">
          {club.role === "admin" ? "AD" : "ST"}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-semibold text-[#eef1ea]">{userEmail}</div>
          <div className="text-[10.5px] text-[#8a9182]">
            {club.role === "admin" ? "Admin" : "Staff"}
          </div>
        </div>
        <form action={signOut}>
          <button type="submit" title="Sign out" className="text-sm text-[#8a9182] hover:text-[#e9ede6]">
            ⏻
          </button>
        </form>
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Verify**

```bash
pnpm exec tsc --noEmit
```

Expected: no errors. (Not wired into a page yet — Task 5 does that — so this only typechecks in isolation for now.)

- [ ] **Step 3: Commit**

```bash
git add src/components/app-shell/sidebar.tsx
git commit -m "Add sidebar with workspace switcher and grouped nav"
```

---

### Task 5: Assemble the shell

**Files:**
- Modify: `src/app/[clubSlug]/layout.tsx`
- Modify: `src/app/[clubSlug]/page.tsx`

**Interfaces:**
- Consumes: `ToastProvider` (Task 1), `PageHeaderProvider`/`AppHeader`/`usePageHeader` (Task 2), `listUserClubs` (Task 3), `Sidebar` (Task 4), plus everything `[clubSlug]/layout.tsx` already consumes from phase 2 (`resolveClubAccess`, `ClubProvider`)
- Produces: the assembled, navigable club shell — nothing further consumes this within this plan; phase 5 renders real screens inside it

- [ ] **Step 1: Replace `src/app/[clubSlug]/layout.tsx`**

Replace its full contents with (the auth/access-check logic — lines computing `user` and `access` — is unchanged from phase 2; only the render output and the new `listUserClubs` call are new):

```tsx
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess, listUserClubs } from "@/lib/auth/club-access";
import { ClubProvider } from "@/lib/club-context";
import { ToastProvider } from "@/lib/toast-context";
import { PageHeaderProvider } from "@/lib/page-header-context";
import { Sidebar } from "@/components/app-shell/sidebar";
import { AppHeader } from "@/components/app-shell/header";

export default async function ClubLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) {
    notFound();
  }

  const clubs = await listUserClubs(supabase);

  return (
    <ClubProvider
      value={{
        clubId: access.clubId,
        slug: access.slug,
        name: access.name,
        initials: access.initials,
        accentColor: access.accentColor,
        role: access.role,
      }}
    >
      <ToastProvider>
        <PageHeaderProvider>
          <div className="flex h-screen w-full overflow-hidden font-sans text-[14px] leading-[1.45] text-foreground">
            <Sidebar clubs={clubs} userEmail={user.email ?? ""} />
            <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <AppHeader />
              <div className="flex-1 overflow-y-auto px-7 py-6">{children}</div>
            </main>
          </div>
        </PageHeaderProvider>
      </ToastProvider>
    </ClubProvider>
  );
}
```

- [ ] **Step 2: Replace `src/app/[clubSlug]/page.tsx`**

Replace its full contents with:

```tsx
"use client";

import { useClub } from "@/lib/club-context";
import { usePageHeader } from "@/lib/page-header-context";

// Placeholder until phase 5 builds the real Dashboard screen (KPI cards,
// activity feed, low-stock alerts). Proves the shell — sidebar, header,
// context — renders real per-page content correctly.
export default function ClubIndexPage() {
  const club = useClub();
  usePageHeader({
    title: "Dashboard",
    subtitle: `${club.name} · signed in as ${club.role}`,
  });

  return (
    <div className="rounded-card border border-border bg-card p-6">
      <p className="text-sm text-[#6b6f66]">
        The real dashboard (KPI cards, activity, low-stock alerts) lands in phase 5.
      </p>
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
pnpm exec tsc --noEmit
pnpm build
```

Expected: both succeed. Build's route table still lists `/[clubSlug]` as dynamic.

- [ ] **Step 4: Manual smoke test**

```bash
pnpm dev &
sleep 3
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/login
kill %1
```

Expected: `/` redirects (not a 500), `/login` returns `200`. (Full visual verification of the sidebar/header requires a real authenticated session — check this manually in a browser if you have test credentials from earlier phases; the curl check only confirms no server error, not visual fidelity.)

- [ ] **Step 5: Run the full test suite**

```bash
pnpm test
```

Expected: same pass/fail profile as Task 3's Step 4 (everything green except the known email-quota tests, if currently rate-limited).

- [ ] **Step 6: Commit**

```bash
git add "src/app/[clubSlug]/layout.tsx" "src/app/[clubSlug]/page.tsx"
git commit -m "Assemble app shell into the club layout"
```

---

## End of phase 3

Stop here for review. What this phase delivers: a real sidebar with a working workspace switcher (including genuine multi-club support, tested), grouped nav pointing at every phase-5 screen's eventual route, a page header pages can set their own title/subtitle into, and a toast system ready for phase-5 screens' save/delete confirmations. Nav items other than Dashboard 404 until phase 5 builds their routes — expected, not a bug. Phase 4 (contract template builder + member sign flow) is the next piece to build inside this shell.
