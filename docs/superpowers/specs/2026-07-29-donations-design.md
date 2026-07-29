# Donations Screen — Design Spec

**Status:** Approved
**Scope:** Phase 5, next screen for GaafD (South African cannabis social club SaaS). Adds `/[clubSlug]/donations` — currently unbuilt (sidebar's "Donations" link 404s today).

## Context

Design reference: `/Users/user/Documents/projects/gaafd/README.md` (§12 "Donations"), `design/GaafD.dc.html` (lines 658-689 list/record view, line 1307 the mock's `recordDonation()`), `screenshots/07-donations.png`. The `donations` table already exists (phase 1, full CRUD RLS, no platform bypass). This is the **first screen that writes to `members.token_balance`** — every prior screen has only ever read it (always 0 until now).

**The mock's member picker is non-functional** — it's hardcoded static text ("Thabo Molefe · GVSC-0102"), never wired to any selection state (unlike Dispensing's `posMemberId`, which is real). The mock's `recordDonation()` also never updates its own donation list and navigates away to Dashboard on save — both prototype shortcuts, not intended real behavior. This spec builds the real thing.

## Data Integrity: Atomic Record + Credit

Recording a donation must do two things together: insert the `donations` row and increment `members.token_balance`. Two separate client-side calls risk a real gap — a failure between them leaves a donation recorded with no tokens credited, or a race between two concurrent donations silently drops one (read-then-write on `token_balance` isn't safe without a transaction).

**New migration** — this project's first Postgres function/RPC (everything else so far is plain table reads/writes):

```sql
create or replace function record_donation(
  p_club_id uuid,
  p_member_id uuid,
  p_amount_rand numeric,
  p_method text
)
returns donations
language plpgsql
security invoker
as $$
declare
  v_row donations;
  v_tokens integer;
begin
  if p_amount_rand is null or p_amount_rand <= 0 then
    raise exception 'Donation amount must be positive';
  end if;

  -- Defense-in-depth, matching this project's established pattern
  -- (signContract, createMovement): the donations INSERT policy only
  -- checks the new row's own club_id, never cross-validates that
  -- member_id belongs to that same club. Without this check, a
  -- mismatched (club_id, member_id) pair would silently insert the
  -- donation while the token-credit UPDATE below matches zero rows
  -- (its WHERE clause requires both id and club_id) — donation recorded,
  -- no tokens credited, no error raised.
  if not exists (select 1 from members where id = p_member_id and club_id = p_club_id) then
    raise exception 'Member not found in this club';
  end if;

  v_tokens := round(p_amount_rand)::integer;

  insert into donations (club_id, member_id, amount_rand, method, tokens_credited)
  values (p_club_id, p_member_id, p_amount_rand, p_method, v_tokens)
  returning * into v_row;

  update members
  set token_balance = token_balance + v_tokens
  where id = p_member_id and club_id = p_club_id;

  return v_row;
end;
$$;
```

`security invoker` (not `security definer`) — the function runs under the CALLING user's own session and RLS, exactly as if they'd made the two writes directly. No privilege escalation, no bypass of tenant isolation. Both the `donations` INSERT and `members` UPDATE remain subject to their existing RLS policies; the function only adds atomicity (a Postgres function body is implicitly one transaction) and the cross-entity ownership check.

`p_method`'s validity is enforced by the existing `donations.method` CHECK constraint (`Cash`/`Card`/`EFT`) — no need to duplicate that check in the function.

## Data Layer

### `src/lib/donations.ts` (new)

```ts
export type DonationMethod = "Cash" | "Card" | "EFT";

export type Donation = {
  id: string;
  memberId: string;
  memberName: string;
  amountRand: number;
  method: DonationMethod;
  tokensCredited: number;
  createdAt: string;
};

export async function getTodaysDonations(supabase: SupabaseClient, clubId: string): Promise<Donation[]>;

export type RecordDonationInput = {
  memberId: string;
  amountRand: number;
  method: DonationMethod;
};

export async function recordDonation(
  supabase: SupabaseClient,
  clubId: string,
  input: RecordDonationInput,
): Promise<Donation>;
```

**`getTodaysDonations`**: filters by `created_at` within `sastDayRange(0)` (reusing the exact SAST-boundary helper already built for Dashboard, so the "Today's donations" label is honest, not just "N most recent"). Two sequential queries (donations, then member names by id — no PostgREST embedding), newest first.

**`recordDonation`**: calls `supabase.rpc("record_donation", {...})`. **Note for implementation**: since the function is declared `returns donations` (a single composite row, not `setof donations`), PostgREST/supabase-js returns `data` as a single object, not an array — this differs from every other Supabase call in this codebase so far (all of which are `.from(...)` table queries returning arrays). Resolves `memberName` via one follow-up query on `members` (matching the pattern already established in `createMovement`'s `productName` resolution).

## Screen

Same Server Component + Client Component split as every prior screen.

- `src/app/[clubSlug]/donations/page.tsx` — `resolveClubAccess` + `notFound()`, `listMembers` (reused from `src/lib/members.ts` — no new member-fetching function needed) and `getTodaysDonations` in parallel, renders header + panel.
- `src/app/[clubSlug]/donations/donations-header.tsx` — title "Donations", subtitle "Cash → token conversion" (the mock's own static copy — no count/club-name interpolation, matching this specific screen's actual design).
- `src/app/[clubSlug]/donations/donations-panel.tsx` — Client Component, two-column layout (`380px 1fr`, matching the mock):
  - **Left card, "Record donation"**: a real member `<select>` (formatted `"{first} {last} ({code})"`, reusing the exact format already established in the registration form's referrer dropdown — filling the gap the mock's hardcoded picker left), an Amount (R) input (whole Rand only, digits-only input mask matching the mock's own regex — deliberately NOT allowing decimals here, unlike Products' cost/sell fields, because this amount converts 1:1 to whole tokens and fractional Rand would need silent rounding either way), method chips (Cash/Card/EFT, styled like every other chip-selector in this app), a live "Tokens credited: +{amount}" preview box, and a "Record donation" button.
  - **Right card, "Today's donations"**: list of `Donation`s (avatar initials, name, method + relative/local time, R amount, `+{tokensCredited} tok`). Empty state: "No donations recorded today yet."
  - On successful record: prepend the new donation to the local list (newest-first, matching `getTodaysDonations`' ordering), show a success toast, reset the form (member/amount/method) — **do NOT navigate away** (the mock's own `recordDonation()` calls `navGo('dashboard')`, but that would defeat the point of showing the fresh entry in the same screen's list, and the mock doesn't even update its own list on save — both are prototype shortcuts, not intended behavior).

## Testing

- `tests/donations.test.ts`, live Supabase, reusing `tests/rls/fixtures.ts`. **Note the baseline is non-empty**: `seedClub()` already seeds one donation per club (R300, `Cash`, 300 tokens credited, `created_at` = now — so it falls inside today's SAST window) tied to the fixture member, matching the same non-empty-baseline pattern already established for members/products/inventory_moves. Tests assert deltas over this baseline, not absolute counts from an assumed-empty table. Covers: `recordDonation` inserts the row AND credits `token_balance` atomically (verify both post-call, as a delta over the fixture's starting balance); rejects a non-positive amount; rejects a member belonging to a different club (the defense-in-depth check); `getTodaysDonations` cross-tenant isolation and correct today-only filtering (a donation backdated outside today's SAST window, inserted directly via the admin client, must NOT appear alongside the fixture's own in-window donation).
- UI verified via `tsc`/`build`/manual smoke test only, per this project's established convention.

## Global Constraints

- Reuse `src/lib/supabase/server.ts`, `src/lib/auth/club-access.ts`'s `resolveClubAccess`, `src/lib/page-header-context.tsx`'s `usePageHeader`, `src/lib/toast-context.tsx`'s `useToast`, `src/lib/members.ts`'s `listMembers`, and `src/lib/format.ts`'s `sastDayRange` exactly as they exist — do not modify any of them.
- No PostgREST relation embedding anywhere.
- No shadcn/`@base-ui/react` components — hand-rolled Tailwind markup, matching every prior screen (this screen has no modal, so no overlay pattern is needed here).
- Every labeled form field needs `htmlFor`/`id` pairing.
- Migration files follow the existing `YYYYMMDDHHMMSS_description.sql` naming, applied via `supabase db push --linked` against the live linked project (ref `inlseklfbptgjketdnpe`).
- pnpm exclusively, Node via `.nvmrc`, commit messages plain/imperative, work on branch `master` directly (standing consent from all prior phases).
