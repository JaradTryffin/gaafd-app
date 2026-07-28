# Member ID Document Upload — Design Spec

**Status:** Approved
**Scope:** Adds front/back ID photo capture to the already-built Registration Step 1 screen. Retroactively fills a gap deliberately scoped out of phase 4 (see `docs/superpowers/plans/2026-07-28-phase-4-contract-sign-flow.md`'s Global Constraints, which omitted ID upload because neither the schema nor Storage was designed for it at the time).

## Context

The design mock's Registration Step 1 view includes ID front/back upload fields, and its Member Detail view (not yet built in this app) displays them. This spec adds the capture + storage half now; viewing is deferred to when Member Detail ships.

**Decisions (user-approved):**
- Optional, not required — nothing in this app currently enforces ID verification (Dispensing, where it would matter per the README's "Age verification required before first dispense," isn't built yet), so gating registration on it would add friction with no enforcement payoff.
- Photos are best-effort, not transactional with registration — if a photo upload fails after the member row is created, registration still succeeds. A failed image upload must never block registering a real person.
- Replaceable, not append-only — unlike `signed_contracts` (a legal audit record), a blurry ID photo should be re-uploadable without accumulating orphaned Storage objects.

## Schema

New migration `supabase/migrations/20260728140000_member_id_documents.sql`:

```sql
alter table members
  add column id_front_url text,
  add column id_back_url text;
```

Both nullable. Store Storage object *paths* (the bucket is private), same convention as `signed_contracts.signature_url` — never a public URL, callers generate a signed URL on demand.

## Storage

New migration `supabase/migrations/20260728140100_storage_member_ids.sql`, mirroring the existing `signatures` bucket's pattern (`supabase/migrations/20260727130200_storage_signatures.sql`):

```sql
insert into storage.buckets (id, name, public)
values ('member-ids', 'member-ids', false)
on conflict (id) do nothing;

create policy member_ids_select on storage.objects for select to authenticated
  using (
    bucket_id = 'member-ids'
    and (storage.foldername(name))[1]::uuid in (select my_club_ids())
  );

create policy member_ids_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'member-ids'
    and (storage.foldername(name))[1]::uuid in (select my_club_ids())
  );

create policy member_ids_update on storage.objects for update to authenticated
  using (
    bucket_id = 'member-ids'
    and (storage.foldername(name))[1]::uuid in (select my_club_ids())
  )
  with check (
    bucket_id = 'member-ids'
    and (storage.foldername(name))[1]::uuid in (select my_club_ids())
  );
```

- Path convention: `{club_id}/{member_id}/front.{ext}` and `{club_id}/{member_id}/back.{ext}` — a stable path per member/side, so re-uploading (via `upsert: true` on the client call) naturally replaces the old object. No DELETE policy — replacement happens via UPDATE (upsert), not delete-then-insert; nothing in this feature needs to remove a photo outright.
- **No `is_platform()` SELECT grant on this bucket** — extends the already-approved policy excluding the platform role from `members`, `signed_contracts`, and the `signatures` bucket. Government ID scans are at least as sensitive as those.
- `.jpg`/`.jpeg`/`.png`/`.heic` accepted (common phone/tablet camera output); client-side `accept="image/*"` on the file input. No server-side MIME/size enforcement beyond Supabase Storage's own defaults — out of scope for this pass (matches this project's existing signature-upload code, which also doesn't add extra validation beyond "non-empty").

## Flow

Extends the already-built `src/app/[clubSlug]/members/register/{register-form.tsx,actions.ts}` and `src/lib/members.ts`'s `registerMember`.

- `register-form.tsx`: two new optional file inputs ("ID front", "ID back"), `accept="image/*"`, no gating on the submit button (per the optional decision above).
- `registerMemberAction` (`actions.ts`): its input type gains `idFront?: File | null` and `idBack?: File | null`. Server Actions support `File` arguments directly (no manual FormData plumbing needed) — the existing calling convention in `register-form.tsx` (a plain object passed via `startTransition`) already works with `File` fields added to it.
- `src/lib/members.ts`: `registerMember` inserts the member row first (unchanged — this is how it already gets `memberId`), then, if either file was provided, uploads to the `member-ids` bucket at the stable per-member path (`upsert: true`) and updates the row's `id_front_url`/`id_back_url` for whichever upload(s) succeeded. An upload failure is caught, logged server-side (`console.error`), and NOT re-thrown — registration's return value (`{ memberId, code }`) is unaffected either way, consistent with the "best-effort, not transactional" decision. No toast/warning UI is added for a partial photo-upload failure — that's new UX surface the user didn't ask for, and would need a way to carry state across the redirect to the Sign step. Staff can always re-upload later once a "manage documents" UI exists (out of scope here).

## Out of Scope

- Viewing the uploaded photos anywhere (Member Detail doesn't exist yet).
- Server-side image validation/resizing/EXIF stripping.
- Editing/removing a member's ID photos outside of the registration flow (no dedicated "manage documents" UI).

## Testing

- Extend `tests/registration.test.ts` (the existing `registerMember` test suite) with cases: registering with both photos provided persists both `id_front_url`/`id_back_url` and the objects are readable from the `member-ids` bucket; registering with no photos leaves both columns `null` and still succeeds; a cross-tenant check that Club B's admin cannot read Club A's `member-ids` objects (mirrors the existing RLS-isolation testing convention for the `signatures` bucket).
- No new UI test file — Registration Step 1's form changes verified via `tsc`/`build`/manual smoke test, per this project's established convention.

## Global Constraints

- Reuse `src/lib/supabase/server.ts`, `src/lib/auth/club-access.ts`'s `resolveClubAccess` exactly as they exist — do not modify.
- Migration files follow the existing `YYYYMMDDHHMMSS_description.sql` naming and are applied via the same Supabase CLI workflow used for every prior migration in this project.
- pnpm exclusively, Node via `.nvmrc`, commit messages plain/imperative, work on branch `master` directly (standing consent from all prior phases).
- Design tokens for the two new form fields: match `register-form.tsx`'s existing field styling exactly (same `htmlFor`/`id` label pairing convention as every other field on that form).
