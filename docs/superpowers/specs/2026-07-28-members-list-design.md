# Members List Screen — Design Spec

**Status:** Approved
**Scope:** Phase 5, next screen for GaafD (South African cannabis social club SaaS). Adds `/[clubSlug]/members` — currently unbuilt (only the `/members/register/*` subtree exists; the sidebar's "Members" link 404s today).

## Context

Design reference: `/Users/user/Documents/projects/gaafd/README.md` (§ "Members list"), `design/GaafD.dc.html` (members-list view), `screenshots/03-members.png`. Searchable table of a club's members with a status filter, linking to a Member Detail screen (out of scope here — deferred, see below) and to the existing member-registration flow.

**Scope boundary (deliberate, mirrors Dashboard's precedent):**
- No global header search box or "+ New dispense" button — neither has a real destination yet in this build.
- Table rows are **not clickable**. Member Detail doesn't exist yet; adding a click affordance that leads nowhere would be a dead end, same reasoning as Dashboard's dropped header actions. Revisit when Member Detail ships.
- This screen's own search box (filters the member list) IS real and included — unlike the header search, it has genuine function here.

## Data Layer

### `src/lib/members.ts` (extend — same file as the existing `registerMember`)

```ts
export type MemberListRow = {
  id: string;
  first: string;
  last: string;
  code: string;
  type: "Full member" | "Day pass" | "Trial";
  tokenBalance: number;
  referrerName: string | null;
  status: "active" | "inactive";
};

export async function listMembers(
  supabase: SupabaseClient,
  clubId: string,
): Promise<MemberListRow[]>;
```

- One query: `select id, first, last, code, type, token_balance, referrer_id, status from members where club_id = clubId order by joined_at desc` (newest-registered-first, user-approved default — no sort control in this screen's scope).
- Referrer names resolved via a self-join in JS against the SAME result set (a referrer is always another member of the same club, already present in the fetched rows) — no second query, no PostgREST embedding (this codebase's established no-embedding convention).
- `token_balance` is read as-is. It's a real column that happens to be 0 for every member today (nothing writes to it yet — no Donations/Dispensing screen exists). This is genuine current state, not a placeholder; no special-casing needed, unlike Dashboard's honest-placeholder cards.

## Screen

### `src/app/[clubSlug]/members/page.tsx` (new, Server Component)
- `resolveClubAccess(supabase, clubSlug)` + `notFound()` (established pattern).
- `listMembers(supabase, access.clubId)`.
- Renders `<MembersHeader clubName={access.name} count={members.length} />` then `<MembersTable clubSlug={clubSlug} members={members} />`.

### `src/app/[clubSlug]/members/members-header.tsx` (new, tiny Client Component)
Same shape as `dashboard-header.tsx`/`success-header.tsx`: `usePageHeader({ title: "Members", subtitle: \`${count} registered · ${clubName}\` })`, returns `null`.

### `src/app/[clubSlug]/members/members-table.tsx` (new, Client Component)
- Local state: `statusFilter: "All" | "Active" | "Inactive"`, `search: string`. Both filter the already-fetched `members` array client-side — no server round-trip per keystroke or chip click, matching `contract-editor.tsx`'s established local-draft-state pattern.
- Search matches against `first + " " + last + " " + code` (case-insensitive substring), matching the design mock's own filter logic.
- Status chips row (All/Active/Inactive) + search input, with a "+ Register member" link to `/${clubSlug}/members/register` (the existing, already-built route) on the same row.
- Table columns, matching the mock exactly:
  - **Member** — 34px avatar circle (`bg-accent text-primary`, initials), name above, mono `code` below.
  - **Type** — plain text (`Full member` / `Day pass` / `Trial`).
  - **Balance** — `tokenBalance`, mono font.
  - **Referred by** — `referrerName` or `"—"`.
  - **Status** — pill using the already-mapped `status-active-bg`/`status-active-fg` / `status-inactive-bg`/`status-inactive-fg` Tailwind utilities.
- Two distinct empty states:
  - Genuinely zero members in the club (before any filtering): "No members yet — register your first member to get started," with the Register button emphasized.
  - Filtered-to-zero (a search/status combination matches nothing): "No members match your filters."

## Testing

- `tests/members.test.ts` (new file — separate from `tests/registration.test.ts`, which covers the registration/sign flow specifically; `listMembers` is a different concern despite living in the same `members.ts` file, matching how `dashboard.test.ts` is its own file for `dashboard.ts`).
- Live Supabase, reusing `tests/rls/fixtures.ts`. Covers: returns the caller's club's members only (cross-tenant check — Club A's list never contains Club B's fixture member); resolves a referrer's name correctly when one seeded-in-test member refers another; newest-registered-first ordering.
- UI (`page.tsx`, `members-header.tsx`, `members-table.tsx`) verified via `tsc`/`build`/manual smoke test only, per this project's established convention for UI tasks.

## Global Constraints

- Reuse `src/lib/supabase/server.ts`, `src/lib/auth/club-access.ts`'s `resolveClubAccess`, `src/lib/page-header-context.tsx`'s `usePageHeader` exactly as they exist — do not modify.
- No PostgREST relation embedding anywhere in this plan (established codebase convention).
- Design tokens: `@theme`-mapped Tailwind utilities (`rounded-card`, `bg-card`, `border-border`, `bg-accent`, `text-primary`, `status-active-bg`/`status-active-fg`, `status-inactive-bg`/`status-inactive-fg`, `font-heading`, `font-mono`) matching every prior screen; arbitrary `text-[#hex]` only for values genuinely absent from the mapped set.
- pnpm exclusively, Node via `.nvmrc`, commit messages plain/imperative, work on branch `master` directly (standing consent from all prior phases).
