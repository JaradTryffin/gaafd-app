# GaafD Phase 0 — Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a working Next.js + TypeScript + Tailwind + shadcn/ui app in `gaafd-app/`, with Supabase client wiring (no live project yet) and a Vitest harness ready for the phase-1 RLS test suite — nothing feature-specific yet.

**Architecture:** Scaffold via `create-next-app` into a temp directory, merge into the existing `gaafd-app/` repo (which already holds `docs/` and `.git` from the spec commits), then layer on shadcn/ui, the GaafD design tokens from the spec, Supabase client stubs, and Vitest, each as its own committed task.

**Tech Stack:** Next.js (latest, App Router), TypeScript, Tailwind CSS, shadcn/ui, `@supabase/supabase-js` + `@supabase/ssr`, react-hook-form + zod, pnpm, Vitest.

## Global Constraints

- Repo root: `/Users/user/Documents/projects/gaafd-app` (sibling to `/Users/user/Documents/projects/gaafd`, the read-only design reference — never edit files under `gaafd/`).
- Package manager: pnpm exclusively — no `npm install` / `yarn add` calls.
- `src/` directory layout, import alias `@/*` (per spec).
- No live Supabase project in this phase — env vars are wired but left empty; real values arrive in phase 1.
- Every task ends with a commit. Commit messages: plain, imperative, no caveman compression (per repo convention already used for the spec commits).
- Design tokens (colors, fonts, radius) must match `gaafd-app/docs/superpowers/specs/2026-07-25-gaafd-saas-design.md` and the original `gaafd/README.md` token table exactly — Task 3 is the source of truth for the concrete values.

---

### Task 1: Scaffold the Next.js app

**Files:**
- Create: everything `create-next-app` generates under `gaafd-app/` (`package.json`, `next.config.ts`, `tsconfig.json`, `src/app/*`, `public/*`, `.gitignore`, eslint config, `postcss.config.mjs`)

**Interfaces:**
- Consumes: nothing (first task)
- Produces: a runnable Next.js app at the repo root; `src/app/layout.tsx` and `src/app/page.tsx` as the entry points later tasks modify

- [ ] **Step 1: Enable pnpm**

```bash
corepack enable
corepack prepare pnpm@latest --activate
pnpm -v
```

Expected: prints a version number (e.g. `9.x.x`). If `corepack enable` fails with a permissions error, run `npm install -g pnpm` instead, then re-run `pnpm -v`.

- [ ] **Step 2: Scaffold into a temp directory**

```bash
cd /Users/user/Documents/projects
pnpm dlx create-next-app@latest gaafd-app-scaffold-tmp \
  --typescript --tailwind --eslint --app --src-dir \
  --import-alias "@/*" --use-pnpm --yes
```

Expected: creates `/Users/user/Documents/projects/gaafd-app-scaffold-tmp` with `package.json`, `src/app/`, etc., ending in a "Success! Created gaafd-app-scaffold-tmp" message.

- [ ] **Step 3: Merge the scaffold into `gaafd-app/`, preserving `docs/` and `.git/`**

```bash
cd /Users/user/Documents/projects
shopt -s dotglob
for f in gaafd-app-scaffold-tmp/*; do
  base=$(basename "$f")
  case "$base" in
    .git|docs) continue ;;
  esac
  mv "$f" gaafd-app/"$base"
done
shopt -u dotglob
rmdir gaafd-app-scaffold-tmp
ls -a /Users/user/Documents/projects/gaafd-app
```

Expected: listing shows `package.json`, `next.config.ts`, `src`, `public`, `tsconfig.json`, `.gitignore`, `node_modules`, `docs`, `.git`, eslint config, `postcss.config.mjs`.

- [ ] **Step 4: Verify the app builds**

```bash
cd /Users/user/Documents/projects/gaafd-app
pnpm install
pnpm exec tsc --noEmit
pnpm build
```

Expected: `tsc --noEmit` prints nothing and exits 0; `pnpm build` ends with a "Compiled successfully" route summary and exits 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/user/Documents/projects/gaafd-app
git add -A
git commit -m "Scaffold Next.js app (TypeScript, Tailwind, App Router, pnpm)"
```

---

### Task 2: shadcn/ui tooling

**Files:**
- Create: `components.json`
- Create: `src/lib/utils.ts`
- Create: `src/components/ui/button.tsx`
- Create: `src/components/ui/input.tsx`
- Modify: `src/app/globals.css` (shadcn appends its base CSS variable block here — Task 3 overwrites the values)

**Interfaces:**
- Consumes: the scaffolded app from Task 1
- Produces: `cn(...inputs: ClassValue[]): string` exported from `src/lib/utils.ts`; `Button`, `buttonVariants` from `src/components/ui/button.tsx`; `Input` from `src/components/ui/input.tsx` — every later screen imports these instead of hand-rolling buttons/inputs

- [ ] **Step 1: Run shadcn init**

```bash
cd /Users/user/Documents/projects/gaafd-app
pnpm dlx shadcn@latest init --yes --base-color neutral
```

Expected: CLI reports success; creates `components.json`; creates `src/lib/utils.ts`; appends a CSS variables block to `src/app/globals.css`.

- [ ] **Step 2: Verify `cn()` was generated**

```bash
cat src/lib/utils.ts
```

Expected:

```ts
import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

- [ ] **Step 3: Add the button and input primitives**

```bash
pnpm dlx shadcn@latest add button input
```

Expected: creates `src/components/ui/button.tsx` (exports `Button`, `buttonVariants`) and `src/components/ui/input.tsx` (exports `Input`).

- [ ] **Step 4: Verify the app still typechecks**

```bash
pnpm exec tsc --noEmit
```

Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add shadcn/ui tooling with button and input primitives"
```

---

### Task 3: Apply GaafD design tokens

**Files:**
- Modify: `src/app/globals.css` (replace shadcn's default CSS variable values with GaafD's exact tokens)
- Modify: `src/app/layout.tsx` (load Bricolage Grotesque, IBM Plex Sans, IBM Plex Mono via `next/font/google`)

**Interfaces:**
- Consumes: `src/app/globals.css` as generated by Task 2's shadcn init
- Produces: CSS custom properties consumed as Tailwind utilities in every later screen — `bg-background`, `text-foreground`, `bg-primary`, `bg-sidebar-bg`, `text-sidebar-text`, `bg-status-active-bg text-status-active-fg`, `font-heading`, `font-sans`, `font-mono`, `rounded-card`, etc.

> **Post-execution note:** Task 2's actual shadcn CLI (4.15.0) was much newer than this plan assumed and generated a different `@theme inline` structure (it already defines `--font-heading` alongside `--font-sans`/`--font-mono`, plus `sidebar-*`/`chart-*`/`.dark` tokens this plan didn't anticipate). Task 3 was executed as a controller-reconciled surgical edit against the real file rather than the literal code below — Bricolage Grotesque maps to the existing `font-heading` utility (not a new `font-display`), IBM Plex Sans maps to `font-sans` (not `font-body`), and the GaafD sidebar tokens were renamed `--sidebar-*-dark`/etc. where they'd otherwise collide with shadcn's own `--sidebar-*` component tokens. The code blocks below are kept for historical record of the original intent; the committed `src/app/globals.css` and `src/app/layout.tsx` are the source of truth for the actual variable names.

- [ ] **Step 1: Read the current generated file to confirm variable names**

```bash
cat src/app/globals.css
```

Note the exact variable names shadcn generated (e.g. `--background`, `--primary`) so Step 2's replacement lines up with what `@theme inline` (or `tailwind.config`, if this Next.js version scaffolded Tailwind v3 instead of v4) actually references. If the generated file uses a `tailwind.config.ts`-based setup instead of the CSS-first `@theme` block shown below, port the same variable names and values into `theme.extend.colors` there instead — the values themselves don't change.

- [ ] **Step 2: Replace `src/app/globals.css` with the GaafD token set**

```css
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

:root {
  --radius: 0.5625rem; /* 9px – buttons/inputs */
  --radius-card: 0.875rem; /* 14px */

  --background: #f7f6f1;
  --foreground: #1c1e1a;

  --card: #ffffff;
  --card-foreground: #1c1e1a;

  --popover: #ffffff;
  --popover-foreground: #1c1e1a;

  --primary: #2f5d3a;
  --primary-foreground: #ffffff;

  --secondary: #f2f0e8;
  --secondary-foreground: #4a4e45;

  --muted: #faf9f4;
  --muted-foreground: #8a8e83;

  --accent: #eef2ec;
  --accent-foreground: #2f5d3a;

  --destructive: #b4432f;
  --destructive-foreground: #ffffff;

  --border: #e7e4db;
  --input: #e0ddd3;
  --ring: #3f7a4e;

  /* GaafD-specific tokens not covered by shadcn's base palette */
  --sidebar-bg: #161a15;
  --sidebar-surface: #20261e;
  --sidebar-border: #2e352b;
  --sidebar-text: #d7dcd3;
  --sidebar-text-muted: #6d7568;
  --sidebar-accent-dot: #6fbf82;

  --link: #3f7a4e;
  --link-hover: #2f5d3a;

  --text-secondary: #4a4e45;
  --text-muted-2: #9a9e93;
  --text-muted-3: #a29c8c;

  --border-2: #e0ddd3;
  --border-3: #f0eee6;
  --border-4: #f4f2ea;
  --border-dashed: #cfccbf;

  --disabled-button: #e4e1d7;

  --status-active-bg: #e7f0e8;
  --status-active-fg: #2f6a3f;
  --status-inactive-bg: #f0eee6;
  --status-inactive-fg: #8a8e83;

  --badge-warn-bg: #3a2318;
  --badge-warn-fg: #e0996a;

  --tenant-accent-1: #3f7a4e;
  --tenant-accent-2: #8a6d3b;
  --tenant-accent-3: #4a6b8a;
  --tenant-accent-4: #7a4a6b;
  --tenant-accent-5: #6b7a4a;
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);

  --color-sidebar-bg: var(--sidebar-bg);
  --color-sidebar-surface: var(--sidebar-surface);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-text: var(--sidebar-text);
  --color-sidebar-text-muted: var(--sidebar-text-muted);
  --color-sidebar-accent-dot: var(--sidebar-accent-dot);

  --color-status-active-bg: var(--status-active-bg);
  --color-status-active-fg: var(--status-active-fg);
  --color-status-inactive-bg: var(--status-inactive-bg);
  --color-status-inactive-fg: var(--status-inactive-fg);

  --font-display: var(--font-display);
  --font-body: var(--font-body);
  --font-mono: var(--font-mono);

  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-card: var(--radius-card);
}

body {
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-body), sans-serif;
  font-size: 14px;
  line-height: 1.45;
}
```

- [ ] **Step 3: Load the three fonts in the root layout**

Edit `src/app/layout.tsx` — replace its font setup with:

```tsx
import { Bricolage_Grotesque, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display",
});

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        className={`${bricolage.variable} ${plexSans.variable} ${plexMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
```

Keep any existing `export const metadata` from the scaffolded file; just replace the font imports/usage and the `<body>` className.

- [ ] **Step 4: Verify**

```bash
pnpm exec tsc --noEmit
pnpm build
```

Expected: both succeed with no errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Apply GaafD design tokens (colors, fonts, radius)"
```

---

### Task 4: Supabase client wiring

**Files:**
- Create: `.env.local.example`
- Create: `src/lib/supabase/client.ts`
- Create: `src/lib/supabase/server.ts`
- Modify: `.gitignore` (only if `.env*.local` isn't already ignored)

**Interfaces:**
- Consumes: nothing new
- Produces: `createClient(): SupabaseClient` (sync) from `src/lib/supabase/client.ts` for Client Components; `createClient(): Promise<SupabaseClient>` (async) from `src/lib/supabase/server.ts` for Server Components/actions — both consumed starting phase 1. (A service-role admin client is deliberately *not* added here — it's introduced in phase 1 alongside the first server action that needs it, once a real Supabase project exists.)

- [ ] **Step 1: Install dependencies**

```bash
pnpm add @supabase/supabase-js @supabase/ssr zod react-hook-form @hookform/resolvers
```

Expected: `package.json` gains these five entries under `dependencies`.

- [ ] **Step 2: Create the env template**

Create `.env.local.example`:

```
# Supabase project settings — from the project's Settings > API page.
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=

# Server-only — never prefix with NEXT_PUBLIC_, never expose to the browser.
# Used by service-role actions (club onboarding, invites) starting phase 1/2.
SUPABASE_SERVICE_ROLE_KEY=
```

- [ ] **Step 3: Confirm `.env*.local` is gitignored**

```bash
grep -n "env" .gitignore
```

Expected: a line matching `.env*.local` (create-next-app adds this by default). If missing, append it:

```bash
echo ".env*.local" >> .gitignore
```

- [ ] **Step 4: Create the browser client**

Create `src/lib/supabase/client.ts`:

```ts
import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
```

- [ ] **Step 5: Create the server client**

Create `src/lib/supabase/server.ts`:

```ts
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // setAll called from a Server Component render — safe to ignore
            // because middleware (added in phase 2) refreshes the session instead.
          }
        },
      },
    },
  );
}
```

- [ ] **Step 6: Verify**

```bash
pnpm exec tsc --noEmit
```

Expected: no errors (the `!` non-null assertions type-check even though the env vars are empty at this point — they're only exercised at runtime, starting phase 1).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Wire Supabase browser/server clients and env template"
```

---

### Task 5: Vitest harness

**Files:**
- Create: `vitest.config.ts`
- Create: `src/lib/utils.test.ts`
- Modify: `package.json` (add `test` script)

**Interfaces:**
- Consumes: `cn()` from `src/lib/utils.ts` (Task 2)
- Produces: a working `pnpm test` command — the phase-1 RLS isolation suite is added as new test files under this same config, no changes to `vitest.config.ts` expected

- [ ] **Step 1: Install Vitest**

```bash
pnpm add -D vitest
```

- [ ] **Step 2: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
  },
});
```

- [ ] **Step 3: Write a real regression test for the one piece of logic that already exists**

Create `src/lib/utils.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("merges class names and resolves tailwind conflicts", () => {
    expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4");
  });

  it("drops falsy values", () => {
    expect(cn("a", false && "b", undefined, "c")).toBe("a c");
  });
});
```

- [ ] **Step 4: Run it**

```bash
pnpm exec vitest run
```

Expected: `Test Files  1 passed (1)`, `Tests  2 passed (2)`.

- [ ] **Step 5: Add the `test` script**

Edit `package.json`, add to `"scripts"`:

```json
"test": "vitest run"
```

- [ ] **Step 6: Verify the script works**

```bash
pnpm test
```

Expected: same passing output as Step 4.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Add Vitest harness"
```

---

## End of phase 0

Stop here for review. Once approved, the next plan (phase 1) covers: creating the real Supabase project, the full schema + RLS migration exactly as specified (`my_club_ids()`, `is_platform()`, tenant-only policies, `clubs` policy, `platform_club_stats`, Storage policies), and the Vitest isolation suite that must go green before phase 2 starts.
