# Loading Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared loading screen that appears in the content pane during navigation between any `/[clubSlug]/*` routes, closing the blank-screen gap that shows today while a destination page's Server Component fetches its data.

**Architecture:** One presentational component (`LoadingScreen`) rendering a spinning ring around the brand mark, a label, three pulsing dots, and an indeterminate progress bar — all via existing CSS variable tokens and three new `@keyframes` blocks matching this codebase's own naming/usage convention (custom `gfXxx`-prefixed keyframes triggered via inline `style={{ animation: "..." }}`, exactly like the existing `gfFade`/`gfToast` keyframes and their usage in `toast-context.tsx:39`). One `loading.tsx` file at `src/app/[clubSlug]/loading.tsx` renders it — Next.js's file convention turns this into a Suspense boundary around the club layout's `{children}` slot, so the sidebar and header (rendered above `{children}` in `src/app/[clubSlug]/layout.tsx`) never unmount during the transition.

**Tech Stack:** Next.js App Router (`loading.tsx` convention), React Server/Client Components, Tailwind v4 (existing `@theme`-mapped CSS variables), plain CSS `@keyframes` in `src/app/globals.css`.

## Global Constraints

- Reuse existing CSS variable tokens (`--primary`, `--border`, `--foreground`) exactly as already used throughout the app — no new hardcoded colors, no new design tokens.
- No shadcn/`@base-ui/react` components — hand-rolled, matching every other screen.
- New keyframes follow this codebase's existing naming convention: `gfXxx` (see `gfFade`, `gfToast` in `src/app/globals.css:199-217`), triggered via inline `style={{ animation: "..." }}` (see `src/lib/toast-context.tsx:39`) — not Tailwind's built-in `animate-spin`/`animate-pulse` utility classes, since those have different default durations than this design calls for and the codebase already has an established custom-keyframe pattern for exactly this situation.
- pnpm exclusively, Node via `.nvmrc`, commit message plain/imperative, work on branch `master` directly (standing consent from all prior phases).

---

### Task 1: Loading screen component + route placement

**Files:**
- Create: `src/components/loading-screen.tsx`
- Create: `src/app/[clubSlug]/loading.tsx`
- Modify: `src/app/globals.css` (append three new `@keyframes` blocks after the existing `gfToast` block, which ends at line 217)

**Interfaces:**
- Produces: `LoadingScreen({ label?: string }): JSX.Element`, default export... no, named export `LoadingScreen` from `src/components/loading-screen.tsx`, consumed by `src/app/[clubSlug]/loading.tsx`.

This is a single self-contained task — no data layer, no server logic, no RLS, nothing for a second task to build on. One task, one review gate.

- [ ] **Step 1: Add the three new keyframes to `globals.css`**

Append after the existing `gfToast` block (currently the last thing in the file, ending at line 217):

```css

@keyframes gfSpin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes gfPulse {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.85);
  }
  50% {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes gfBar {
  0% {
    left: -40%;
  }
  100% {
    left: 100%;
  }
}
```

- [ ] **Step 2: Create `src/components/loading-screen.tsx`**

```tsx
export function LoadingScreen({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex h-full min-h-[320px] w-full flex-col items-center justify-center gap-6">
      <div className="relative flex h-[88px] w-[88px] items-center justify-center">
        <div
          className="absolute inset-0 rounded-full border-[3px] border-border"
          style={{ borderTopColor: "var(--primary)", animation: "gfSpin 0.9s linear infinite" }}
        />
        <div className="flex h-14 w-14 items-center justify-center rounded-[16px] bg-primary font-heading text-[28px] font-bold text-white shadow-[0_6px_18px_rgba(47,93,58,.28)]">
          G
        </div>
      </div>

      <div className="flex flex-col items-center gap-3">
        <div className="text-center text-[16px] font-semibold tracking-[-0.01em] text-foreground">
          {label}
        </div>
        <div className="flex gap-[7px]">
          {[0, 0.18, 0.36].map((delay) => (
            <span
              key={delay}
              className="h-2 w-2 rounded-full bg-primary"
              style={{ animation: `gfPulse 1.1s ease-in-out infinite`, animationDelay: `${delay}s` }}
            />
          ))}
        </div>
      </div>

      <div className="relative h-[3px] w-[200px] overflow-hidden rounded-full bg-border">
        <div
          className="absolute top-0 h-full w-2/5 rounded-full bg-primary"
          style={{ animation: "gfBar 1.3s ease-in-out infinite" }}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create `src/app/[clubSlug]/loading.tsx`**

```tsx
import { LoadingScreen } from "@/components/loading-screen";

export default function ClubLoading() {
  return <LoadingScreen label="Loading…" />;
}
```

- [ ] **Step 4: Verify with `tsc` and `build`**

Run: `pnpm exec tsc --noEmit`
Expected: no output, exit 0.

Run: `pnpm build`
Expected: clean production build; route table includes the existing `/[clubSlug]/*` routes unchanged (a `loading.tsx` file does not add its own route entry — confirm the build simply succeeds with no new errors, and no route table regression versus the pre-change build).

- [ ] **Step 5: Manual browser smoke test**

Start the dev server (`pnpm dev`), sign in, and throttle the Network tab (Slow 3G or an equivalent artificial delay) or add a temporary `await new Promise(r => setTimeout(r, 2000))` at the top of `src/app/[clubSlug]/donations/page.tsx`'s component body (remove before committing — this is purely to make the transition visible for the manual check, not a permanent change).

Navigate from Donations to Dashboard (or any two club routes) and confirm:
- The loading screen appears in the content pane during the transition (ring spinning, dots pulsing in sequence, bar sweeping left-to-right).
- The sidebar and top header do NOT flicker, unmount, or re-render during the transition — they stay exactly as they were.
- The transition back to real page content is clean (no layout jump, no flash of unstyled content).

Remove the temporary artificial delay from `donations/page.tsx` before committing if you added one.

- [ ] **Step 6: Commit**

```bash
git add src/components/loading-screen.tsx src/app/[clubSlug]/loading.tsx src/app/globals.css
git commit -m "Add loading screen for club route transitions"
```

---

## Self-Review Notes

- **Spec coverage**: component (✅ Step 2), placement (✅ Step 3), animations via existing token/convention pattern (✅ Step 1, corrected from the spec's initial assumption of reusing Tailwind's `animate-spin`/`animate-pulse` after discovering the codebase's actual established convention is custom `gfXxx` keyframes + inline `style={{ animation }}`, not Tailwind's animation utility classes — this keeps the new code consistent with `gfFade`/`gfToast` rather than introducing a second animation-authoring style side by side with it), manual verification (✅ Step 5). No automated test, matching the spec's explicit call-out that presentational-only components in this codebase (e.g. `dispensing-header.tsx`) have none.
- **Placeholder scan**: none found — every step has complete, real code.
- **Type consistency**: `LoadingScreen`'s single prop (`label?: string`, default `"Loading…"`) is defined once in Step 2 and consumed with a literal string in Step 3 — no drift possible within a single task.
