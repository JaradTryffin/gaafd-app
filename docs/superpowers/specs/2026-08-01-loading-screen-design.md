# Loading Screen — Design Spec

**Status:** Approved
**Scope:** Phase 5 polish item for GaafD. Adds route-transition loading feedback inside the club app shell — currently navigating between any two `/[clubSlug]/*` pages (e.g. Donations → Dashboard) shows a blank/frozen content pane for a few seconds while the destination page's Server Component fetches its data, because no `loading.tsx` exists anywhere in the app.

## Context

Design reference: `/Users/user/Downloads/Loading.dc.html` — a full-viewport loading treatment: a spinning ring around a brand mark, a label, three pulsing dots, and an indeterminate progress bar underneath. The mock exposes a `label` prop and a `light`/`dark` `variant` prop with hardcoded hex colors for each.

This app has no active dark mode (the only `dark:` references in the codebase are unused shadcn scaffold components, confirmed via grep — no theme toggle, no `next-themes`). The mock's light-variant hex values map closely to this app's existing CSS variable tokens (already used everywhere via `var(--primary)`, `var(--card)`, `var(--border)`, `var(--muted-foreground)`, e.g. in `dispensing-panel.tsx`), so this build uses those tokens directly instead of introducing a second hardcoded palette or a variant prop that has nothing to switch to yet.

`src/app/[clubSlug]/layout.tsx` renders `Sidebar` and `AppHeader` directly, then passes `{children}` through to the routed page. Next.js's `loading.tsx` convention creates a Suspense boundary around a segment's `{children}` — a `loading.tsx` placed at `src/app/[clubSlug]/loading.tsx` therefore wraps every nested route under it (dashboard, members, products, inventory, donations, dispense, settings) without ever unmounting the layout that renders the sidebar/header. This is what makes "content-area-only" loading (sidebar stays visible, only the page pane shows the loading treatment) come for free from file placement, with no manual Suspense wiring.

## Component

### `src/components/loading-screen.tsx` (new)

```tsx
export function LoadingScreen({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex h-full min-h-[320px] w-full flex-col items-center justify-center gap-6">
      <div className="relative flex h-[88px] w-[88px] items-center justify-center">
        <div
          className="absolute inset-0 animate-spin rounded-full border-[3px] border-border"
          style={{ borderTopColor: "var(--primary)", animationDuration: "0.9s" }}
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
              className="h-2 w-2 animate-pulse rounded-full bg-primary"
              style={{ animationDelay: `${delay}s`, animationDuration: "1.1s" }}
            />
          ))}
        </div>
      </div>

      <div className="relative h-[3px] w-[200px] overflow-hidden rounded-full bg-border">
        <div className="absolute top-0 h-full w-2/5 animate-[loading-bar_1.3s_ease-in-out_infinite] rounded-full bg-primary" />
      </div>
    </div>
  );
}
```

The ring-spin and dot-pulse reuse Tailwind's built-in `animate-spin`/`animate-pulse` utilities (already available, no new keyframes needed for those two). The indeterminate bar sweep is the one genuinely new animation — added as a single `@keyframes loading-bar` block in `src/app/globals.css` (`from { left: -40% } to { left: 100% }`, matching the mock's `gfBar` keyframe), registered as a Tailwind arbitrary-value animation via the `animate-[loading-bar_...]` class shown above so no `tailwind.config` changes are needed.

Brand mark styling (`bg-primary`, `font-heading`, `font-bold`, `text-white`, rounded corners) matches the existing sidebar mark (`src/components/app-shell/sidebar.tsx:56`), scaled up from 30px/9px-radius to the mock's 56px/16px-radius for a loading-screen-appropriate size.

No props beyond `label` (defaulted) — no `variant` prop, since there is nothing for it to switch between yet. If dark mode is ever added to this app, this component should be revisited then, not speculatively built for now.

## Placement

### `src/app/[clubSlug]/loading.tsx` (new)

```tsx
import { LoadingScreen } from "@/components/loading-screen";

export default function ClubLoading() {
  return <LoadingScreen label="Loading…" />;
}
```

One file, one generic label, covers every route nested under the club layout. `Sidebar`/`AppHeader` (rendered by `[clubSlug]/layout.tsx` above `{children}`) are unaffected — they don't re-render or unmount during this transition, matching the "content-area-only" decision.

Out of scope for this build (not touched): `/login`, `/select-club`, `/platform`, and first-ever page load (before the club layout has ever mounted) — `LoadingScreen` is exported as a reusable component specifically so any of these can adopt it later without rework, but none are wired up now.

## Testing

- No automated test — this is a pure presentational component with no data/logic, consistent with this project's convention of skipping automated tests for presentation-only pieces (e.g. `dispensing-header.tsx`, `donations-header.tsx` have none either).
- Verified via `tsc`/`build`, and a manual browser check: navigate between two club routes with the Network tab throttled (or a brief artificial delay) to confirm the loading screen actually appears in the content pane, the sidebar/header stay static and don't flicker, and the transition back to real content is clean.

## Global Constraints

- Reuse existing CSS variable tokens (`--primary`, `--border`, `--foreground`) exactly as already used throughout the app — no new hardcoded colors, no new design tokens.
- No shadcn/`@base-ui/react` components — hand-rolled, matching every other screen.
- pnpm exclusively, Node via `.nvmrc`, commit message plain/imperative, work on branch `master` directly (standing consent from all prior phases).
