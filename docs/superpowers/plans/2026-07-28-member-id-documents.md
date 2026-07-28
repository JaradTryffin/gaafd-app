# Member ID Document Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional front/back ID photo capture to the already-built Registration Step 1 screen — two new schema columns, a new private Storage bucket with tenant-scoped RLS, and the upload/UI wiring.

**Architecture:** Two SQL migrations applied to the live linked Supabase project first (schema column + Storage bucket/policies), then a data-layer task (`registerMember` extended to upload photos best-effort), then a UI task (two new optional file inputs on the existing registration form).

**Tech Stack:** Supabase Postgres + Storage + RLS, Next.js Server Actions (native `File` argument support), Vitest.

## Global Constraints

- Reuse `src/lib/supabase/server.ts`, `src/lib/auth/club-access.ts`'s `resolveClubAccess` exactly as they exist — do not modify.
- Migration files follow the existing `YYYYMMDDHHMMSS_description.sql` naming, applied via `supabase db push --linked` against the live project (ref `inlseklfbptgjketdnpe`) — the same command and workflow used for every prior migration in this project.
- pnpm exclusively, Node via `.nvmrc` (run `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use` before any command).
- Commit messages plain, imperative. Work on branch `master` directly (standing consent from all prior phases).
- Design tokens for the two new form fields must match `register-form.tsx`'s existing field styling exactly — same wrapper/label classes, same `htmlFor`/`id` pairing convention as every other field on that form.
- No `is_platform()` SELECT grant on the `member-ids` bucket — extends this project's already-established policy excluding the platform role from reading `members`, `signed_contracts`, and the `signatures` bucket. Government ID scans are at least as sensitive as those.
- Photo upload is best-effort, never transactional with registration: a failed upload must never cause `registerMember` to throw or registration to fail.

---

### Task 1: Migrations — schema column + Storage bucket

**Files:**
- Create: `supabase/migrations/20260728140000_member_id_documents.sql`
- Create: `supabase/migrations/20260728140100_storage_member_ids.sql`

**Interfaces:**
- Produces: `members.id_front_url` (nullable text), `members.id_back_url` (nullable text), a private Storage bucket `member-ids` with SELECT/INSERT/UPDATE RLS scoped by `club_id` (the first path segment) — consumed by Task 2.

This task has no application code and no Vitest suite — there's no function to test yet. Verification is against the live project directly.

- [ ] **Step 1: Write the schema migration**

Create `supabase/migrations/20260728140000_member_id_documents.sql`:

```sql
alter table members
  add column id_front_url text,
  add column id_back_url text;
```

- [ ] **Step 2: Write the Storage migration**

Create `supabase/migrations/20260728140100_storage_member_ids.sql`:

```sql
insert into storage.buckets (id, name, public)
values ('member-ids', 'member-ids', false)
on conflict (id) do nothing;

-- Path convention: {club_id}/{member_id}/front.{ext} and
-- {club_id}/{member_id}/back.{ext} — a stable path per member/side, so a
-- re-upload (client passes upsert:true) replaces the old object instead of
-- accumulating orphans. Unlike the signatures bucket (append-only legal
-- record), ID photos are correctable, hence the UPDATE policy below.
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

- [ ] **Step 3: Apply the migrations**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use && supabase db push --linked`
Expected: lists both new migrations, prompts to confirm, applies them, ends with `Finished supabase db push.`

- [ ] **Step 4: Verify nothing is left pending**

Run: `supabase db push --linked --dry-run`
Expected: no pending migrations listed.

- [ ] **Step 5: Verify against the live project**

Using the Supabase SQL editor (or any authenticated Postgres client against the project), confirm:

```sql
select column_name from information_schema.columns
where table_name = 'members' and column_name in ('id_front_url', 'id_back_url');
```
Expected: both rows returned.

```sql
select id, public from storage.buckets where id = 'member-ids';
```
Expected: one row, `public = false`.

```sql
select policyname from pg_policies
where schemaname = 'storage' and tablename = 'objects' and policyname like 'member_ids_%';
```
Expected: `member_ids_select`, `member_ids_insert`, `member_ids_update` — three rows.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260728140000_member_id_documents.sql supabase/migrations/20260728140100_storage_member_ids.sql
git commit -m "Add members.id_front_url/id_back_url columns and the member-ids Storage bucket"
```

---

### Task 2: `registerMember` upload logic

**Files:**
- Modify: `src/lib/members.ts` (extend `RegisterMemberInput` and `registerMember` — the file also has `nextMemberCode`, `listMembers`, `MemberListRow`; do not alter those)
- Test: `tests/registration.test.ts` (extend — existing file already tests `registerMember`/`signContract`; do not duplicate its `beforeAll`/`seedTenants` setup)

**Interfaces:**
- Consumes: Task 1's `member-ids` bucket and `members.id_front_url`/`id_back_url` columns.
- Produces: `RegisterMemberInput` gains `idFront?: File | null` and `idBack?: File | null`. `registerMember`'s return type is UNCHANGED (`{ memberId: string; code: string }`) — consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

`tests/registration.test.ts` currently starts like this (read the file first to confirm — do not guess):

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedTenants, cleanupTenants, signInAs, type SeededData } from "./rls/fixtures";
import { createAdminClient } from "@/lib/supabase/admin";
import { registerMember } from "@/lib/members";
import { signContract, getOrCreateContractTemplate } from "@/lib/contracts";

// A minimal valid 1x1 PNG data URL, same fixture used by tests/rls/fixtures.ts.
const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let data: SeededData;
let clubAClient: SupabaseClient;
let clubBClient: SupabaseClient;
const cleanupMemberIds: string[] = [];
const cleanupSignaturePaths: string[] = [];

beforeAll(async () => {
  data = await seedTenants();
  clubAClient = await signInAs(data.clubA.adminEmail, data.clubA.adminPassword);
  clubBClient = await signInAs(data.clubB.adminEmail, data.clubB.adminPassword);
}, 30000);

afterAll(async () => {
  const admin = createAdminClient();
  if (cleanupSignaturePaths.length > 0) {
    await admin.storage.from("signatures").remove(cleanupSignaturePaths);
  }
  for (const memberId of cleanupMemberIds) {
    await admin.from("members").delete().eq("id", memberId);
  }
  if (data) {
    await cleanupTenants(data);
  }
}, 30000);
```

Make these three changes to that header (keep everything else in the file — the `describe("registerMember", ...)` and `describe("signContract", ...)` blocks — exactly as-is):

1. Add a `TINY_PNG_BYTES` constant right after `TINY_PNG_DATA_URL`, derived from it (don't duplicate the base64 literal):

```ts
const TINY_PNG_BYTES = Buffer.from(
  TINY_PNG_DATA_URL.replace(/^data:image\/png;base64,/, ""),
  "base64",
);
```

2. Add a new top-level array alongside the existing two:

```ts
const cleanupIdPhotoPaths: string[] = [];
```

3. Extend the existing `afterAll` to also clean up the `member-ids` bucket (add this block right after the existing `signatures` cleanup, before the `members` delete loop):

```ts
  if (cleanupIdPhotoPaths.length > 0) {
    await admin.storage.from("member-ids").remove(cleanupIdPhotoPaths);
  }
```

Then append this new `describe` block at the end of the file (after the existing `describe("signContract", ...)` block's closing `});`):

```ts
describe("registerMember with ID photos", () => {
  it("uploads both ID photos and saves their paths when provided", async () => {
    const idFront = new File([TINY_PNG_BYTES], "front.png", { type: "image/png" });
    const idBack = new File([TINY_PNG_BYTES], "back.png", { type: "image/png" });

    const { memberId } = await registerMember(clubAClient, {
      clubId: data.clubA.clubId,
      first: "Photo",
      last: "Both",
      type: "Full member",
      idFront,
      idBack,
    });
    cleanupMemberIds.push(memberId);
    const frontPath = `${data.clubA.clubId}/${memberId}/front.png`;
    const backPath = `${data.clubA.clubId}/${memberId}/back.png`;
    cleanupIdPhotoPaths.push(frontPath, backPath);

    const admin = createAdminClient();
    const { data: row } = await admin
      .from("members")
      .select("id_front_url, id_back_url")
      .eq("id", memberId)
      .single();
    expect(row?.id_front_url).toBe(frontPath);
    expect(row?.id_back_url).toBe(backPath);

    const { data: downloaded, error: downloadError } = await admin.storage
      .from("member-ids")
      .download(frontPath);
    expect(downloadError).toBeNull();
    expect(downloaded).not.toBeNull();
  });

  it("leaves both columns null and still succeeds when no photos are provided", async () => {
    const { memberId } = await registerMember(clubAClient, {
      clubId: data.clubA.clubId,
      first: "Photo",
      last: "None",
      type: "Trial",
    });
    cleanupMemberIds.push(memberId);

    const admin = createAdminClient();
    const { data: row } = await admin
      .from("members")
      .select("id_front_url, id_back_url")
      .eq("id", memberId)
      .single();
    expect(row?.id_front_url).toBeNull();
    expect(row?.id_back_url).toBeNull();
  });

  it("does not let club B read a photo stored under club A's folder", async () => {
    const idFront = new File([TINY_PNG_BYTES], "front.png", { type: "image/png" });
    const { memberId } = await registerMember(clubAClient, {
      clubId: data.clubA.clubId,
      first: "Photo",
      last: "Isolation",
      type: "Trial",
      idFront,
    });
    cleanupMemberIds.push(memberId);
    const path = `${data.clubA.clubId}/${memberId}/front.png`;
    cleanupIdPhotoPaths.push(path);

    const { error } = await clubBClient.storage.from("member-ids").download(path);
    expect(error).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/registration.test.ts`
Expected: FAIL — `registerMember` doesn't accept `idFront`/`idBack` yet (TypeScript error) or the uploaded paths are `undefined`/missing (depending on how loosely typed the call site is); either way, the three new tests do not pass yet.

- [ ] **Step 3: Implement**

Modify `src/lib/members.ts`. Add `idFront?: File | null;` and `idBack?: File | null;` to the end of `RegisterMemberInput`:

```ts
export type RegisterMemberInput = {
  clubId: string;
  first: string;
  last: string;
  type: "Full member" | "Day pass" | "Trial";
  status?: "active" | "inactive";
  phone?: string;
  email?: string;
  appHandle?: string;
  referrerId?: string;
  idFront?: File | null;
  idBack?: File | null;
};
```

Add these two helpers above `registerMember` (below `nextMemberCode`):

```ts
function extensionForFile(file: File): string {
  if (file.type === "image/png") return "png";
  if (file.type === "image/heic" || file.type === "image/heif") return "heic";
  return "jpg";
}

async function uploadIdPhoto(
  supabase: SupabaseClient,
  clubId: string,
  memberId: string,
  side: "front" | "back",
  file: File,
): Promise<string | null> {
  const path = `${clubId}/${memberId}/${side}.${extensionForFile(file)}`;
  const { error } = await supabase.storage
    .from("member-ids")
    .upload(path, file, { contentType: file.type || "image/jpeg", upsert: true });
  if (error) {
    console.error(`Failed to upload ID ${side} photo for member ${memberId}:`, error);
    return null;
  }
  return path;
}
```

Replace the body of `registerMember`'s success branch (the `if (!error) { return { memberId: data.id, code: data.code }; }` block) with:

```ts
    if (!error) {
      const memberId = data.id as string;
      const updates: { id_front_url?: string; id_back_url?: string } = {};
      if (input.idFront) {
        const path = await uploadIdPhoto(supabase, input.clubId, memberId, "front", input.idFront);
        if (path) updates.id_front_url = path;
      }
      if (input.idBack) {
        const path = await uploadIdPhoto(supabase, input.clubId, memberId, "back", input.idBack);
        if (path) updates.id_back_url = path;
      }
      if (Object.keys(updates).length > 0) {
        const { error: updateError } = await supabase
          .from("members")
          .update(updates)
          .eq("id", memberId);
        if (updateError) {
          console.error(`Failed to save ID photo path(s) for member ${memberId}:`, updateError);
        }
      }
      return { memberId, code: data.code as string };
    }
```

The rest of `registerMember` (the retry loop, the `throw error` / final `throw new Error(...)`) is unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/registration.test.ts`
Expected: PASS, all tests green (the pre-existing `registerMember`/`signContract` tests plus the 3 new ones — 3 + 4 + 3 = 10 total, but count what's actually in the file after your edit rather than trusting this number). Live Supabase project — this will take longer than a mocked suite, and depends on Task 1's migrations already being applied.

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/members.ts tests/registration.test.ts
git commit -m "Upload ID photos best-effort during member registration"
```

---

### Task 3: Registration Step 1 UI

**Files:**
- Modify: `src/app/[clubSlug]/members/register/register-form.tsx`
- Modify: `src/app/[clubSlug]/members/register/actions.ts`

**Interfaces:**
- Consumes: Task 2's extended `RegisterMemberInput` (specifically the `idFront`/`idBack` fields) via `registerMember`, called inside `registerMemberAction`.

This task has no test file — verified via `tsc`/`build`/manual smoke test, per this project's established convention for UI-only tasks.

- [ ] **Step 1: Add the two file inputs to the form**

In `src/app/[clubSlug]/members/register/register-form.tsx`, add two new pieces of state right after the existing `const [status, setStatus] = useState("active");` line:

```tsx
  const [idFront, setIdFront] = useState<File | null>(null);
  const [idBack, setIdBack] = useState<File | null>(null);
```

In `handleSubmit`, add `idFront` and `idBack` to the object passed to `registerMemberAction` (alongside the existing fields — `appHandle: appHandle || undefined,` is currently the last field before the closing `});`):

```tsx
        appHandle: appHandle || undefined,
        idFront,
        idBack,
```

In the JSX, add two new field blocks inside the existing `<form>`'s grid, immediately after the "Initial status" field block (i.e. right before the `{error && ...}` line):

```tsx
          <div>
            <label htmlFor="idFront" className="mb-1 block text-[11px] text-[#8a8e83]">
              ID front (optional)
            </label>
            <input
              id="idFront"
              type="file"
              accept="image/*"
              onChange={(e) => setIdFront(e.target.files?.[0] ?? null)}
              className="w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px]"
            />
          </div>
          <div>
            <label htmlFor="idBack" className="mb-1 block text-[11px] text-[#8a8e83]">
              ID back (optional)
            </label>
            <input
              id="idBack"
              type="file"
              accept="image/*"
              onChange={(e) => setIdBack(e.target.files?.[0] ?? null)}
              className="w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px]"
            />
          </div>
```

No change to the submit button's `disabled` logic — photos stay optional, per the approved spec.

- [ ] **Step 2: Forward the fields through the server action**

In `src/app/[clubSlug]/members/register/actions.ts`, add `idFront?: File | null;` and `idBack?: File | null;` to `registerMemberAction`'s input type (after the existing `appHandle?: string;` line):

```ts
export async function registerMemberAction(input: {
  clubSlug: string;
  clubId: string;
  first: string;
  last: string;
  email?: string;
  phone?: string;
  type: "Full member" | "Day pass" | "Trial";
  status: "active" | "inactive";
  referrerId?: string;
  appHandle?: string;
  idFront?: File | null;
  idBack?: File | null;
}): Promise<{ error: string } | void> {
```

No other change to this file — it already forwards the whole `input` object straight into `registerMember(supabase, input)`.

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Build**

Run: `pnpm build`
Expected: succeeds.

- [ ] **Step 5: Manual smoke test**

This route requires an authenticated session. Follow the Members-list plan's Task 2 methodology (an isolated throwaway test club + throwaway admin user created via `createAdminClient()`, NOT the real shared `demo` club), sign in, then submit the registration form with both file fields populated (any small valid image works) and confirm: (a) the form submits successfully and redirects to the Sign step, (b) querying the `members` table for the new row shows non-null `id_front_url`/`id_back_url`. Also submit once with no files selected and confirm registration still succeeds with both columns `null`. Delete the throwaway club/user and any created member/Storage objects immediately after, and verify the deletion with a follow-up query (don't just trust the delete calls didn't error).

- [ ] **Step 6: Commit**

```bash
git add src/app/\[clubSlug\]/members/register/register-form.tsx src/app/\[clubSlug\]/members/register/actions.ts
git commit -m "Add optional ID front/back photo upload to Registration Step 1"
```

---

## Self-Review Notes

- **Spec coverage:** schema + Storage (Task 1), upload logic + best-effort failure handling + tests (Task 2), UI wiring (Task 3) — every section of `docs/superpowers/specs/2026-07-28-member-id-documents-design.md` maps to a task. "Out of Scope" items (viewing photos, server-side validation, a documents-management UI) are correctly NOT tasks here.
- **Type consistency checked:** `idFront?: File | null` / `idBack?: File | null` field names and types are identical across `RegisterMemberInput` (Task 2), the test calls (Task 2), and `registerMemberAction`'s input type + the form's `useState`/submit call (Task 3).
- **No placeholders:** every step has complete, runnable code.
- **Migration-first ordering is deliberate:** Task 2's tests will fail against a project that hasn't had Task 1's migrations applied (the `member-ids` bucket and the two columns won't exist) — this is expected and matches this project's established migration-then-code task ordering (see the phase-1 schema/RLS plan).
