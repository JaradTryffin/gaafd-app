# GaafD Phase 4 — Contract Template Builder + Member Sign Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first fully end-to-end feature against Supabase: a per-club contract template (editor + live preview), member registration, and the canvas-signature sign flow that writes an immutable, snapshotted `signed_contracts` audit record with a real Storage upload.

**Architecture:** Two new library modules (`src/lib/contracts.ts`, `src/lib/members.ts`) hold all business logic and get live Vitest coverage; three route trees (`members/register`, `members/register/sign/[memberId]`, `settings/contract`) are thin Server Component (data fetch) + Client Component (interactivity) pairs consuming those modules, following the pattern already established in phases 2-3.

**Tech Stack:** Next.js Server Actions + Route params, Supabase Postgres + Storage, Canvas Pointer Events, the phase-3 shell (`useClub`, `usePageHeader`, `useToast`).

## Global Constraints

- Reuse exactly as-is, never modify: `src/lib/supabase/server.ts`, `src/lib/auth/club-access.ts`'s `resolveClubAccess` (it already returns a `plan` field from phase 3 — ignore that field here, it's not relevant to this phase), `src/lib/club-context.tsx`'s `useClub`, `src/lib/toast-context.tsx`'s `useToast`, `src/lib/page-header-context.tsx`'s `usePageHeader`.
- Package manager: pnpm exclusively. Node 24.18.0 via `.nvmrc` (`export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use` before running anything).
- Commit messages: plain, imperative. Work on branch `master` directly (standing consent from phases 0-3).
- Tasks 1-2 (data layer) get live Vitest tests against the real Supabase project (ref `inlseklfbptgjketdnpe`), reusing `tests/rls/fixtures.ts`'s `seedTenants`/`cleanupTenants`/`signInAs` — same pattern as every prior phase, no mocks. Tasks 3-5 (UI) are verified via `tsc`/`build`/manual smoke test only — this project has no component/DOM testing framework and doesn't add one here.
- Design tokens must match `gaafd/README.md`'s token table and the already-committed `@theme` mappings in `src/app/globals.css`. Use mapped Tailwind utilities where they exist: `rounded-card`, `bg-card`, `border-border`, `bg-muted`, `bg-accent`, `text-destructive`, `font-heading`, `bg-primary`, `border-input`. Use arbitrary `bg-[var(--x)]`/inline `style` for tokens with no mapping (`--border-dashed`, `--status-active-fg`, etc.).
- **Deliberate scope boundary, not an oversight:** the design reference's Registration Step 1 mock includes required ID-document photo upload fields. Neither the phase-1 `members` table nor Supabase Storage was ever designed to store them, and the spec's own Phase 4 description ("template CRUD, canvas signature capture... Storage upload, signed_contracts snapshot write") doesn't mention ID capture at all. This phase's registration form omits the ID upload fields entirely — that boundary was already implied by the approved spec, this plan isn't making a new unilateral cut.
- Similarly, the mock's "Pending verification" initial-status option doesn't exist in the `members` table's actual `status` check constraint (`active`|`inactive` only, from the already-reviewed phase-1 migration). The registration form offers **Active/Inactive** only.
- `signed_contracts` and the `signatures` Storage bucket are append-only (SELECT+INSERT only, no UPDATE policy — phase 1). Any code that needs to "correct" a signed record must never attempt an update; it wasn't designed to be possible and RLS will reject it.

---

## File Structure

- `src/lib/contracts.ts` — contract template CRUD + `signContract` (Tasks 1-2).
- `tests/contracts.test.ts` — template business-logic tests (Task 1).
- `src/lib/members.ts` — `registerMember` (Task 2).
- `tests/registration.test.ts` — registration + sign-contract tests (Task 2).
- `src/app/[clubSlug]/members/register/{page.tsx,register-form.tsx,actions.ts}` — Registration Step 1 (Task 3).
- `src/components/sign/signature-pad.tsx` — canvas signature capture (Task 4).
- `src/app/[clubSlug]/members/register/sign/[memberId]/{page.tsx,sign-form.tsx,actions.ts}` — Sign Agreement Step 2 (Task 4).
- `src/app/[clubSlug]/members/register/success/{page.tsx,success-header.tsx}` — Registration success (Task 4).
- `src/app/[clubSlug]/settings/contract/{page.tsx,contract-editor.tsx,actions.ts}` — Contract template builder (Task 5).

---

### Task 1: Contract template data layer

**Files:**
- Create: `src/lib/contracts.ts`
- Create: `tests/contracts.test.ts`

**Interfaces:**
- Consumes: nothing new (plain `SupabaseClient` parameter, same DI pattern as every other `src/lib` module in this project)
- Produces: `type ContractClause = { heading: string; body: string }`, `type ContractTemplate = { id: string; clubId: string; title: string; subtitle: string; consent: string; clauses: ContractClause[]; version: number; updatedAt: string }`, `getOrCreateContractTemplate(supabase, clubId, clubName): Promise<ContractTemplate>`, `saveContractTemplate(supabase, clubId, input): Promise<ContractTemplate>`, `resetContractTemplate(supabase, clubId, clubName): Promise<ContractTemplate>` — consumed by Task 2's `signContract`, Task 4's sign page, Task 5's builder page

- [ ] **Step 1: Write the module**

Create `src/lib/contracts.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

export type ContractClause = {
  heading: string;
  body: string;
};

export type ContractTemplate = {
  id: string;
  clubId: string;
  title: string;
  subtitle: string;
  consent: string;
  clauses: ContractClause[];
  version: number;
  updatedAt: string;
};

type ContractTemplateRow = {
  id: string;
  club_id: string;
  title: string;
  subtitle: string;
  consent: string;
  clauses: unknown;
  version: number;
  updated_at: string;
};

const TEMPLATE_COLUMNS = "id, club_id, title, subtitle, consent, clauses, version, updated_at";

function mapTemplate(row: ContractTemplateRow): ContractTemplate {
  return {
    id: row.id,
    clubId: row.club_id,
    title: row.title,
    subtitle: row.subtitle,
    consent: row.consent,
    clauses: row.clauses as ContractClause[],
    version: row.version,
    updatedAt: row.updated_at,
  };
}

// Reproduces the design reference's defaultContract() verbatim — this is
// the seed copy every club starts with, reviewable legal-adjacent text
// that must not drift from the source.
function defaultContract(clubName: string): {
  title: string;
  subtitle: string;
  consent: string;
  clauses: ContractClause[];
} {
  return {
    title: `${clubName} — Member Agreement`,
    subtitle:
      "Private Membership Agreement for access to cannabis.\nThis agreement operates under South African law permitting the private possession and consumption of cannabis for personal use.",
    consent:
      "I have read and agree to the terms of this Member Agreement. I confirm I am 21 years or older and that the information I have provided is accurate.",
    clauses: [
      {
        heading: "Introduction",
        body: `This Agreement is entered into between ${clubName} (Pty) Ltd and the Member. The Club operates in accordance with South African law permitting the private possession and consumption of cannabis for personal use.`,
      },
      {
        heading: "Eligibility & Membership",
        body: "Membership is open only to persons aged 21 years or older.\nJoining is voluntary and grants private, members-only access.\nAccess is conditional on continued compliance with this Agreement.",
      },
      {
        heading: "Nature of Cannabis Supply",
        body: "The Club facilitates private consumption among consenting adult members.\nCannabis is for personal use only — resale or distribution to non-members or minors is strictly prohibited.\nAll activity remains within the private-use scope established by the 2018 Constitutional Court ruling.",
      },
      {
        heading: "Code of Conduct",
        body: "No conduct that endangers the safety, reputation, or operation of the Club.\nNo consumption on the premises unless in a designated, by-law compliant space.\nNo attending under the influence and no disruptive or unlawful behaviour.\nBreach may result in termination of membership without refund.",
      },
      {
        heading: "Confidentiality & Privacy",
        body: "Member data is handled in accordance with POPIA.\nNo information is shared with third parties unless legally required.",
      },
      {
        heading: "Membership Fees",
        body: "Fees may cover contributions to cultivation, packaging, and operational costs.\nFees are not payment for cannabis itself — they represent an operational and logistical contribution only.",
      },
      {
        heading: "Liability Waiver",
        body: "The Member indemnifies the Club against any claims or damages arising from use.\nThe Member acknowledges the associated psychological and physical risks.",
      },
      {
        heading: "Termination",
        body: "Either party may terminate this Agreement, with or without reason, on written notice.\nThe Club may revoke membership immediately in the event of a breach.",
      },
      {
        heading: "Governing Law",
        body: "This Agreement is governed by the laws of the Republic of South Africa.",
      },
    ],
  };
}

export async function getOrCreateContractTemplate(
  supabase: SupabaseClient,
  clubId: string,
  clubName: string,
): Promise<ContractTemplate> {
  const { data: existing, error: fetchError } = await supabase
    .from("contract_templates")
    .select(TEMPLATE_COLUMNS)
    .eq("club_id", clubId)
    .maybeSingle();
  if (fetchError) throw fetchError;
  if (existing) return mapTemplate(existing);

  const seed = defaultContract(clubName);
  const { data: created, error: insertError } = await supabase
    .from("contract_templates")
    .insert({
      club_id: clubId,
      title: seed.title,
      subtitle: seed.subtitle,
      consent: seed.consent,
      clauses: seed.clauses,
      version: 1,
    })
    .select(TEMPLATE_COLUMNS)
    .single();

  if (insertError) {
    // contract_templates.club_id is UNIQUE — a concurrent first-access
    // could have already inserted it between our SELECT and INSERT.
    // Re-fetch instead of surfacing a spurious error.
    if (insertError.code === "23505") {
      const { data: retry, error: retryError } = await supabase
        .from("contract_templates")
        .select(TEMPLATE_COLUMNS)
        .eq("club_id", clubId)
        .single();
      if (retryError) throw retryError;
      return mapTemplate(retry);
    }
    throw insertError;
  }
  return mapTemplate(created);
}

export async function saveContractTemplate(
  supabase: SupabaseClient,
  clubId: string,
  input: { title: string; subtitle: string; consent: string; clauses: ContractClause[] },
): Promise<ContractTemplate> {
  const { data: existing } = await supabase
    .from("contract_templates")
    .select("version")
    .eq("club_id", clubId)
    .maybeSingle();

  const { data, error } = await supabase
    .from("contract_templates")
    .upsert(
      {
        club_id: clubId,
        title: input.title,
        subtitle: input.subtitle,
        consent: input.consent,
        clauses: input.clauses,
        version: (existing?.version ?? 0) + 1,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "club_id" },
    )
    .select(TEMPLATE_COLUMNS)
    .single();
  if (error) throw error;
  return mapTemplate(data);
}

export async function resetContractTemplate(
  supabase: SupabaseClient,
  clubId: string,
  clubName: string,
): Promise<ContractTemplate> {
  const seed = defaultContract(clubName);
  return saveContractTemplate(supabase, clubId, seed);
}
```

- [ ] **Step 2: Write the tests**

Create `tests/contracts.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedTenants, cleanupTenants, signInAs, type SeededData } from "./rls/fixtures";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getOrCreateContractTemplate,
  saveContractTemplate,
  resetContractTemplate,
} from "@/lib/contracts";

let data: SeededData;
let clubAClient: SupabaseClient;

beforeAll(async () => {
  data = await seedTenants();
  clubAClient = await signInAs(data.clubA.adminEmail, data.clubA.adminPassword);
}, 30000);

afterAll(async () => {
  if (data) {
    await cleanupTenants(data);
  }
}, 30000);

describe("getOrCreateContractTemplate", () => {
  it("seeds a real default template for a club with no existing row", async () => {
    // tests/rls/fixtures.ts's seedClub() already inserts a minimal test
    // template for every club it creates (shared infrastructure other
    // test files rely on) — so clubA/clubB from seedTenants() are NOT
    // template-less. The only way to genuinely exercise the "no row yet"
    // seeding path is a throwaway club created here, not reused from
    // seedTenants.
    const admin = createAdminClient();
    const suffix = crypto.randomUUID().slice(0, 8);
    const { data: club, error } = await admin
      .from("clubs")
      .insert({
        slug: `contracts-test-${suffix}`,
        name: `Contracts Test Club ${suffix}`,
        initials: "CT",
        plan: "Trial",
        region: "Test Region",
        accent_color: "#3f7a4e",
        status: "active",
      })
      .select()
      .single();
    if (error) throw error;

    try {
      const template = await getOrCreateContractTemplate(admin, club.id, "Contracts Test Club");
      expect(template.title).toContain("Contracts Test Club");
      expect(template.clauses).toHaveLength(9);
      expect(template.version).toBe(1);
    } finally {
      await admin.from("clubs").delete().eq("id", club.id);
    }
  });

  it("returns the same template on a second call, not a duplicate", async () => {
    const first = await getOrCreateContractTemplate(clubAClient, data.clubA.clubId, "Test Club A");
    const second = await getOrCreateContractTemplate(clubAClient, data.clubA.clubId, "Test Club A");
    expect(second.id).toBe(first.id);
    expect(second.version).toBe(first.version);
  });
});

describe("saveContractTemplate", () => {
  it("updates content and increments the version", async () => {
    const before = await getOrCreateContractTemplate(clubAClient, data.clubA.clubId, "Test Club A");
    const updated = await saveContractTemplate(clubAClient, data.clubA.clubId, {
      title: "Updated Title",
      subtitle: "Updated subtitle",
      consent: "Updated consent",
      clauses: [{ heading: "Only Clause", body: "Only body" }],
    });
    expect(updated.title).toBe("Updated Title");
    expect(updated.clauses).toHaveLength(1);
    expect(updated.version).toBe(before.version + 1);
  });
});

describe("resetContractTemplate", () => {
  it("restores the default text and still increments the version", async () => {
    await saveContractTemplate(clubAClient, data.clubA.clubId, {
      title: "Something Else Entirely",
      subtitle: "x",
      consent: "x",
      clauses: [{ heading: "x", body: "x" }],
    });
    const before = await getOrCreateContractTemplate(clubAClient, data.clubA.clubId, "Test Club A");

    const reset = await resetContractTemplate(clubAClient, data.clubA.clubId, "Test Club A");
    expect(reset.title).toBe("Test Club A — Member Agreement");
    expect(reset.clauses).toHaveLength(9);
    expect(reset.version).toBe(before.version + 1);
  });
});
```

- [ ] **Step 3: Run it**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use
cd /Users/user/Documents/projects/gaafd-app
pnpm exec vitest run tests/contracts.test.ts
```

Expected: `4 passed`. Hits the live Supabase project.

- [ ] **Step 4: Commit**

```bash
git add src/lib/contracts.ts tests/contracts.test.ts
git commit -m "Add contract template data layer"
```

---

### Task 2: Member registration + sign-contract data layer

**Files:**
- Create: `src/lib/members.ts`
- Modify: `src/lib/contracts.ts` (append `SignContractInput` type and `signContract`)
- Create: `tests/registration.test.ts`

**Interfaces:**
- Consumes: `getOrCreateContractTemplate` (Task 1, same file)
- Produces: `RegisterMemberInput` type, `registerMember(supabase, input): Promise<{ memberId: string; code: string }>` from `src/lib/members.ts`; `SignContractInput` type, `signContract(supabase, input): Promise<{ signedContractId: string }>` from `src/lib/contracts.ts` — consumed by Task 3's register action and Task 4's sign action

- [ ] **Step 1: Write the member registration module**

Create `src/lib/members.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

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
};

async function nextMemberCode(supabase: SupabaseClient, clubId: string): Promise<string> {
  const { data: club, error: clubError } = await supabase
    .from("clubs")
    .select("initials")
    .eq("id", clubId)
    .single();
  if (clubError) throw clubError;

  const { count, error: countError } = await supabase
    .from("members")
    .select("id", { count: "exact", head: true })
    .eq("club_id", clubId);
  if (countError) throw countError;

  const sequence = (count ?? 0) + 1;
  return `${club.initials}-${String(sequence).padStart(4, "0")}`;
}

export async function registerMember(
  supabase: SupabaseClient,
  input: RegisterMemberInput,
): Promise<{ memberId: string; code: string }> {
  const code = await nextMemberCode(supabase, input.clubId);
  const { data, error } = await supabase
    .from("members")
    .insert({
      club_id: input.clubId,
      code,
      first: input.first,
      last: input.last,
      type: input.type,
      status: input.status ?? "active",
      phone: input.phone || null,
      email: input.email || null,
      app_handle: input.appHandle || null,
      referrer_id: input.referrerId || null,
    })
    .select("id, code")
    .single();
  if (error) throw error;
  return { memberId: data.id, code: data.code };
}
```

- [ ] **Step 2: Append `signContract` to `src/lib/contracts.ts`**

Add to the end of `src/lib/contracts.ts` (after `resetContractTemplate`):

```ts
export type SignContractInput = {
  clubId: string;
  clubName: string;
  memberId: string;
  printedName: string;
  consent: boolean;
  signaturePngBase64: string;
};

export async function signContract(
  supabase: SupabaseClient,
  input: SignContractInput,
): Promise<{ signedContractId: string }> {
  if (!input.consent) {
    throw new Error("Consent is required to sign");
  }

  const base64 = input.signaturePngBase64.replace(/^data:image\/png;base64,/, "");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) {
    throw new Error("A signature is required to sign");
  }

  // Defense-in-depth: RLS's signed_contracts INSERT policy only checks
  // that the NEW row's club_id belongs to the caller — it doesn't verify
  // member_id actually belongs to that same club. Check explicitly so a
  // bug can't create a record linking one club's data to another club's
  // member.
  const { data: member, error: memberError } = await supabase
    .from("members")
    .select("id")
    .eq("id", input.memberId)
    .eq("club_id", input.clubId)
    .maybeSingle();
  if (memberError) throw memberError;
  if (!member) {
    throw new Error("Member not found in this club");
  }

  const template = await getOrCreateContractTemplate(supabase, input.clubId, input.clubName);

  // Generated client-side, not the DB default, because the Storage path
  // needs this id BEFORE the row exists, and signed_contracts is
  // append-only (no UPDATE policy) — "insert then patch signature_url"
  // is not possible.
  const signedContractId = crypto.randomUUID();
  const signaturePath = `${input.clubId}/${input.memberId}/${signedContractId}.png`;

  const { error: uploadError } = await supabase.storage
    .from("signatures")
    .upload(signaturePath, bytes, { contentType: "image/png" });
  if (uploadError) throw uploadError;

  const { error: insertError } = await supabase.from("signed_contracts").insert({
    id: signedContractId,
    club_id: input.clubId,
    member_id: input.memberId,
    template_version: template.version,
    contract_snapshot: {
      title: template.title,
      subtitle: template.subtitle,
      consent: template.consent,
      clauses: template.clauses,
    },
    consent: input.consent,
    printed_name: input.printedName || null,
    signature_url: signaturePath,
  });
  if (insertError) throw insertError;

  return { signedContractId };
}
```

- [ ] **Step 3: Write the tests**

Create `tests/registration.test.ts`:

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

describe("registerMember", () => {
  it("generates a code following the club's initials", async () => {
    const { memberId, code } = await registerMember(clubAClient, {
      clubId: data.clubA.clubId,
      first: "Test",
      last: "One",
      type: "Full member",
    });
    cleanupMemberIds.push(memberId);
    // Format is {club initials}-{4-digit sequence}; the fixture club's
    // initials are uppercase letters, so this is a real, meaningful check
    // of the generated shape, not just "some string came back".
    expect(code).toMatch(/^[A-Z]+-\d{4}$/);
  });

  it("generates sequential codes for successive registrations", async () => {
    const first = await registerMember(clubAClient, {
      clubId: data.clubA.clubId,
      first: "Seq",
      last: "One",
      type: "Trial",
    });
    cleanupMemberIds.push(first.memberId);
    const second = await registerMember(clubAClient, {
      clubId: data.clubA.clubId,
      first: "Seq",
      last: "Two",
      type: "Trial",
    });
    cleanupMemberIds.push(second.memberId);

    const firstSeq = Number(first.code.split("-")[1]);
    const secondSeq = Number(second.code.split("-")[1]);
    expect(secondSeq).toBe(firstSeq + 1);
  });
});

describe("signContract", () => {
  it("uploads a signature and creates a signed_contracts row matching the current template", async () => {
    const { memberId } = await registerMember(clubAClient, {
      clubId: data.clubA.clubId,
      first: "Signer",
      last: "Test",
      type: "Full member",
    });
    cleanupMemberIds.push(memberId);

    const template = await getOrCreateContractTemplate(
      clubAClient,
      data.clubA.clubId,
      "Test Club A",
    );

    const { signedContractId } = await signContract(clubAClient, {
      clubId: data.clubA.clubId,
      clubName: "Test Club A",
      memberId,
      printedName: "Signer Test",
      consent: true,
      signaturePngBase64: TINY_PNG_DATA_URL,
    });
    cleanupSignaturePaths.push(`${data.clubA.clubId}/${memberId}/${signedContractId}.png`);

    const admin = createAdminClient();
    const { data: row } = await admin
      .from("signed_contracts")
      .select("contract_snapshot, template_version, consent, printed_name")
      .eq("id", signedContractId)
      .single();
    expect(row?.template_version).toBe(template.version);
    expect(row?.consent).toBe(true);
    expect(row?.printed_name).toBe("Signer Test");
    expect((row?.contract_snapshot as { title: string }).title).toBe(template.title);
  });

  it("rejects when consent is false", async () => {
    const { memberId } = await registerMember(clubAClient, {
      clubId: data.clubA.clubId,
      first: "NoConsent",
      last: "Test",
      type: "Full member",
    });
    cleanupMemberIds.push(memberId);

    await expect(
      signContract(clubAClient, {
        clubId: data.clubA.clubId,
        clubName: "Test Club A",
        memberId,
        printedName: "",
        consent: false,
        signaturePngBase64: TINY_PNG_DATA_URL,
      }),
    ).rejects.toThrow();
  });

  it("rejects when the member belongs to a different club than the one passed in", async () => {
    const { memberId: clubBMemberId } = await registerMember(clubBClient, {
      clubId: data.clubB.clubId,
      first: "WrongClub",
      last: "Test",
      type: "Full member",
    });
    cleanupMemberIds.push(clubBMemberId);

    await expect(
      signContract(clubAClient, {
        clubId: data.clubA.clubId,
        clubName: "Test Club A",
        memberId: clubBMemberId,
        printedName: "",
        consent: true,
        signaturePngBase64: TINY_PNG_DATA_URL,
      }),
    ).rejects.toThrow("Member not found in this club");
  });
});
```

- [ ] **Step 4: Run it**

```bash
pnpm exec vitest run tests/registration.test.ts
```

Expected: `5 passed`.

- [ ] **Step 5: Run the full suite**

```bash
pnpm test
```

Expected: everything green except the pre-documented `tests/auth/invites.test.ts` email-quota tests, if currently rate-limited (unrelated, known since phase 2).

- [ ] **Step 6: Commit**

```bash
git add src/lib/members.ts src/lib/contracts.ts tests/registration.test.ts
git commit -m "Add member registration and sign-contract data layer"
```

---

### Task 3: Registration Step 1 route

**Files:**
- Create: `src/app/[clubSlug]/members/register/page.tsx`
- Create: `src/app/[clubSlug]/members/register/register-form.tsx`
- Create: `src/app/[clubSlug]/members/register/actions.ts`

**Interfaces:**
- Consumes: `resolveClubAccess` (phase 2), `registerMember` (Task 2), `usePageHeader` (phase 3)
- Produces: the `/[clubSlug]/members/register` route — consumed by Task 4's sign page redirect target and a link back from it

- [ ] **Step 1: Write the page**

Create `src/app/[clubSlug]/members/register/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import { RegisterMemberForm } from "./register-form";

export default async function RegisterMemberPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const supabase = await createClient();
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();

  const { data: members } = await supabase
    .from("members")
    .select("id, first, last, code")
    .eq("club_id", access.clubId)
    .order("first", { ascending: true });

  return (
    <RegisterMemberForm clubSlug={clubSlug} clubId={access.clubId} existingMembers={members ?? []} />
  );
}
```

- [ ] **Step 2: Write the form**

Create `src/app/[clubSlug]/members/register/register-form.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { usePageHeader } from "@/lib/page-header-context";
import { registerMemberAction } from "./actions";

type ExistingMember = { id: string; first: string; last: string; code: string };

export function RegisterMemberForm({
  clubSlug,
  clubId,
  existingMembers,
}: {
  clubSlug: string;
  clubId: string;
  existingMembers: ExistingMember[];
}) {
  usePageHeader({
    title: "New member registration",
    subtitle: "Capture identity and membership details, then sign the agreement.",
  });

  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [type, setType] = useState("Full member");
  const [referrerId, setReferrerId] = useState("");
  const [appHandle, setAppHandle] = useState("");
  const [status, setStatus] = useState("active");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await registerMemberAction({
        clubSlug,
        clubId,
        first,
        last,
        email: email || undefined,
        phone: phone || undefined,
        type: type as "Full member" | "Day pass" | "Trial",
        status: status as "active" | "inactive",
        referrerId: referrerId || undefined,
        appHandle: appHandle || undefined,
      });
      if (result?.error) {
        setError(result.error);
      }
    });
  }

  return (
    <div className="max-w-[820px]">
      <div className="rounded-card border border-border bg-card p-[22px]">
        <div className="mb-0.5 font-heading text-lg font-bold">New member registration</div>
        <p className="mb-4 text-[12.5px] text-[#6b6f66]">
          Age verification required before first dispense.
        </p>
        <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-3.5">
          <div>
            <label className="mb-1 block text-[11px] text-[#8a8e83]">First name *</label>
            <input
              required
              value={first}
              onChange={(e) => setFirst(e.target.value)}
              placeholder="e.g. Thabo"
              className="w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px]"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-[#8a8e83]">Last name *</label>
            <input
              required
              value={last}
              onChange={(e) => setLast(e.target.value)}
              placeholder="e.g. Molefe"
              className="w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px]"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-[#8a8e83]">Email (optional)</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@email.com"
              className="w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px]"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-[#8a8e83]">Phone (optional)</label>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+27…"
              className="w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px]"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-[#8a8e83]">Membership type</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="w-full rounded-[9px] border border-input bg-card px-3 py-2.5 text-[13px]"
            >
              <option>Full member</option>
              <option>Day pass</option>
              <option>Trial</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-[#8a8e83]">Referred by (optional)</label>
            <select
              value={referrerId}
              onChange={(e) => setReferrerId(e.target.value)}
              className="w-full rounded-[9px] border border-input bg-card px-3 py-2.5 text-[13px]"
            >
              <option value="">—</option>
              {existingMembers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.first} {m.last} ({m.code})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-[#8a8e83]">
              Linked app username (optional)
            </label>
            <input
              value={appHandle}
              onChange={(e) => setAppHandle(e.target.value)}
              placeholder="@username"
              className="w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px]"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-[#8a8e83]">Initial status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-full rounded-[9px] border border-input bg-card px-3 py-2.5 text-[13px]"
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>

          {error && <p className="col-span-2 text-[12.5px] text-destructive">{error}</p>}

          <div className="col-span-2 mt-1.5 flex justify-end gap-2.5">
            <a
              href={`/${clubSlug}`}
              className="rounded-[9px] border border-input bg-muted px-[18px] py-2.5 text-[13px] text-[#4a4e45]"
            >
              Cancel
            </a>
            <button
              type="submit"
              disabled={isPending}
              className="rounded-[9px] px-5 py-2.5 text-[13px] font-semibold text-white"
              style={{ background: "var(--primary)" }}
            >
              {isPending ? "Continuing…" : "Continue"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write the server action**

Create `src/app/[clubSlug]/members/register/actions.ts`:

```ts
"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { registerMember } from "@/lib/members";

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
}): Promise<{ error: string } | void> {
  const supabase = await createClient();

  let memberId: string;
  try {
    const result = await registerMember(supabase, input);
    memberId = result.memberId;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to register member" };
  }

  redirect(`/${input.clubSlug}/members/register/sign/${memberId}`);
}
```

- [ ] **Step 4: Verify**

```bash
pnpm exec tsc --noEmit
pnpm build
```

Expected: both succeed. Build's route table lists `/[clubSlug]/members/register`.

- [ ] **Step 5: Commit**

```bash
git add "src/app/[clubSlug]/members/register"
git commit -m "Add Registration Step 1 route"
```

---

### Task 4: Signature pad + Sign Agreement + Registration success

**Files:**
- Create: `src/components/sign/signature-pad.tsx`
- Create: `src/app/[clubSlug]/members/register/sign/[memberId]/page.tsx`
- Create: `src/app/[clubSlug]/members/register/sign/[memberId]/sign-form.tsx`
- Create: `src/app/[clubSlug]/members/register/sign/[memberId]/actions.ts`
- Create: `src/app/[clubSlug]/members/register/success/page.tsx`
- Create: `src/app/[clubSlug]/members/register/success/success-header.tsx`

**Interfaces:**
- Consumes: `resolveClubAccess` (phase 2), `getOrCreateContractTemplate` (Task 1), `signContract` (Task 2), `usePageHeader` (phase 3)
- Produces: the full sign flow, terminating at `/[clubSlug]/members/register/success` — nothing further in this plan consumes it

- [ ] **Step 1: Write the signature pad**

Create `src/components/sign/signature-pad.tsx`:

```tsx
"use client";

import { forwardRef, useImperativeHandle, useRef } from "react";

export type SignaturePadHandle = {
  clear: () => void;
  toDataURL: () => string | null;
};

export const SignaturePad = forwardRef<SignaturePadHandle, { onInkChange: (hasInk: boolean) => void }>(
  function SignaturePad({ onInkChange }, ref) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const drawingRef = useRef(false);
    const lastRef = useRef<{ x: number; y: number } | null>(null);
    const hasInkRef = useRef(false);

    useImperativeHandle(ref, () => ({
      clear() {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
        hasInkRef.current = false;
        onInkChange(false);
      },
      toDataURL() {
        if (!hasInkRef.current || !canvasRef.current) return null;
        return canvasRef.current.toDataURL("image/png");
      },
    }));

    function setCanvasRef(node: HTMLCanvasElement | null) {
      canvasRef.current = node;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      if (!rect.width) return;
      node.width = rect.width * 2;
      node.height = rect.height * 2;
      const ctx = node.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      ctx.lineWidth = 2.4;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#1c2e20";
    }

    function pos(e: React.PointerEvent<HTMLCanvasElement>) {
      const rect = e.currentTarget.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
      e.preventDefault();
      drawingRef.current = true;
      lastRef.current = pos(e);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Some browsers reject capture for certain pointer types — drawing
        // still works without it, just without guaranteed event delivery
        // outside the canvas bounds.
      }
      if (!hasInkRef.current) {
        hasInkRef.current = true;
        onInkChange(true);
      }
    }

    function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
      if (!drawingRef.current || !canvasRef.current || !lastRef.current) return;
      const ctx = canvasRef.current.getContext("2d");
      if (!ctx) return;
      const p = pos(e);
      ctx.beginPath();
      ctx.moveTo(lastRef.current.x, lastRef.current.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      lastRef.current = p;
    }

    function handlePointerUp() {
      drawingRef.current = false;
    }

    return (
      <canvas
        ref={setCanvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{ touchAction: "none", cursor: "crosshair" }}
        className="block h-full w-full"
      />
    );
  },
);
```

- [ ] **Step 2: Write the sign page**

Create `src/app/[clubSlug]/members/register/sign/[memberId]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import { getOrCreateContractTemplate } from "@/lib/contracts";
import { SignAgreementForm } from "./sign-form";

export default async function SignAgreementPage({
  params,
}: {
  params: Promise<{ clubSlug: string; memberId: string }>;
}) {
  const { clubSlug, memberId } = await params;
  const supabase = await createClient();
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();

  const { data: member } = await supabase
    .from("members")
    .select("id, first, last")
    .eq("id", memberId)
    .eq("club_id", access.clubId)
    .maybeSingle();
  if (!member) notFound();

  const template = await getOrCreateContractTemplate(supabase, access.clubId, access.name);

  return (
    <SignAgreementForm
      clubSlug={clubSlug}
      clubId={access.clubId}
      clubName={access.name}
      memberId={member.id}
      memberName={`${member.first} ${member.last}`}
      template={template}
    />
  );
}
```

- [ ] **Step 3: Write the sign form**

Create `src/app/[clubSlug]/members/register/sign/[memberId]/sign-form.tsx`:

```tsx
"use client";

import { useRef, useState, useTransition } from "react";
import { SignaturePad, type SignaturePadHandle } from "@/components/sign/signature-pad";
import { completeSignAction } from "./actions";
import type { ContractClause } from "@/lib/contracts";

export function SignAgreementForm({
  clubSlug,
  clubId,
  clubName,
  memberId,
  memberName,
  template,
}: {
  clubSlug: string;
  clubId: string;
  clubName: string;
  memberId: string;
  memberName: string;
  template: { title: string; subtitle: string; consent: string; clauses: ContractClause[] };
}) {
  const [consent, setConsent] = useState(false);
  const [hasInk, setHasInk] = useState(false);
  const [printedName, setPrintedName] = useState(memberName);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const padRef = useRef<SignaturePadHandle>(null);

  const canSign = consent && hasInk && !isPending;
  const signDate = new Date().toLocaleDateString("en-ZA");

  function handleSign() {
    const dataUrl = padRef.current?.toDataURL();
    if (!dataUrl) {
      setError("Add a signature before signing.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await completeSignAction({
        clubSlug,
        clubId,
        clubName,
        memberId,
        printedName,
        consent,
        signaturePngBase64: dataUrl,
      });
      if (result?.error) {
        setError(result.error);
      }
    });
  }

  return (
    <div className="max-w-[840px]">
      <div className="overflow-hidden rounded-card border border-border bg-card">
        <div className="px-[22px] pb-1.5 pt-5">
          <div className="font-heading text-lg font-bold">{template.title}</div>
          <div className="mt-1 whitespace-pre-line text-[12.5px] text-[#6b6f66]">
            {template.subtitle}
          </div>
        </div>
        <div className="m-[22px] max-h-[320px] overflow-y-auto rounded-[11px] border border-border bg-muted px-[18px] py-4">
          {template.clauses.map((clause, index) => (
            <div key={index} className="mb-3.5">
              <div className="font-heading text-[13.5px] font-semibold">
                {index + 1}. {clause.heading}
              </div>
              <div className="mt-1 whitespace-pre-line text-[12.5px] leading-[1.55] text-[#4a4e45]">
                {clause.body}
              </div>
            </div>
          ))}
        </div>
        <div className="px-[22px] pb-[22px] pt-2">
          <label className="flex cursor-pointer items-start gap-2.5 rounded-[10px] border border-border bg-muted p-3.5 text-[12.5px] text-[#4a4e45]">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-primary"
            />
            <span>
              I have read and agree to the {template.title}. I confirm I am 21 years or older and
              that all information provided is accurate.
            </span>
          </label>

          <div className="mt-4 grid grid-cols-[1.4fr_1fr] gap-3.5">
            <div>
              <label className="mb-1 block text-[11px] text-[#8a8e83]">
                Printed name (optional)
              </label>
              <input
                value={printedName}
                onChange={(e) => setPrintedName(e.target.value)}
                placeholder="Member's name for records"
                className="w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px]"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-[#8a8e83]">Date</label>
              <input
                value={signDate}
                readOnly
                className="w-full rounded-[9px] border border-input bg-muted px-3 py-2.5 font-mono text-[13px] text-[#6b6f66]"
              />
            </div>
          </div>

          <div className="mt-3.5">
            <div className="mb-1 flex items-center">
              <label className="text-[11px] text-[#8a8e83]">
                Signature — sign with your finger or Apple Pencil
              </label>
              <button
                type="button"
                onClick={() => padRef.current?.clear()}
                className="ml-auto text-[11.5px] text-[#6b6f66] hover:text-destructive"
              >
                Clear
              </button>
            </div>
            <div className="relative h-[150px] overflow-hidden rounded-xl border border-input bg-card">
              <SignaturePad ref={padRef} onInkChange={setHasInk} />
              {!hasInk && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center font-serif text-[22px] italic text-[#d8d5cb]">
                  Sign here
                </div>
              )}
              <div className="pointer-events-none absolute bottom-[26px] left-[18px] right-[18px] border-b border-[#ece9df]" />
              <div className="pointer-events-none absolute bottom-2 right-3.5 font-mono text-[9.5px] tracking-[.04em] text-[#b7b3a6]">
                e-signature · {clubName}
              </div>
            </div>
          </div>

          {error && <p className="mt-3 text-[12.5px] text-destructive">{error}</p>}

          <div className="mt-5 flex items-center justify-end gap-2.5">
            {!canSign && !error && (
              <span className="mr-auto text-[11.5px] text-[#a29c8c]">
                Tick consent and add a signature to enable
              </span>
            )}
            <a
              href={`/${clubSlug}/members/register`}
              className="rounded-[9px] border border-input bg-muted px-[18px] py-2.5 text-[13px] text-[#4a4e45]"
            >
              Back
            </a>
            <button
              type="button"
              disabled={!canSign}
              onClick={handleSign}
              className="rounded-[9px] px-5 py-2.5 text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#e4e1d7] disabled:text-[#a29c8c]"
              style={canSign ? { background: "var(--primary)" } : undefined}
            >
              {isPending ? "Signing…" : "Sign & complete registration"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Write the sign server action**

Create `src/app/[clubSlug]/members/register/sign/[memberId]/actions.ts`:

```ts
"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signContract } from "@/lib/contracts";

export async function completeSignAction(input: {
  clubSlug: string;
  clubId: string;
  clubName: string;
  memberId: string;
  printedName: string;
  consent: boolean;
  signaturePngBase64: string;
}): Promise<{ error: string } | void> {
  const supabase = await createClient();

  try {
    await signContract(supabase, input);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to sign" };
  }

  redirect(`/${input.clubSlug}/members/register/success?memberId=${input.memberId}`);
}
```

- [ ] **Step 5: Write the success page**

Create `src/app/[clubSlug]/members/register/success/success-header.tsx`:

```tsx
"use client";

import { usePageHeader } from "@/lib/page-header-context";

export function SuccessHeader() {
  usePageHeader({ title: "Registration complete" });
  return null;
}
```

Create `src/app/[clubSlug]/members/register/success/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import { SuccessHeader } from "./success-header";

export default async function RegistrationSuccessPage({
  params,
  searchParams,
}: {
  params: Promise<{ clubSlug: string }>;
  searchParams: Promise<{ memberId?: string }>;
}) {
  const { clubSlug } = await params;
  const { memberId } = await searchParams;
  const supabase = await createClient();
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();

  const { data: member } = memberId
    ? await supabase
        .from("members")
        .select("first, last, code")
        .eq("id", memberId)
        .eq("club_id", access.clubId)
        .maybeSingle()
    : { data: null };

  return (
    <>
      <SuccessHeader />
      <div className="mx-auto mt-10 max-w-[520px] text-center">
        <div className="rounded-2xl border border-border bg-card p-10">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-accent text-[30px] text-primary">
            ✓
          </div>
          <div className="font-heading text-[22px] font-bold">Member registered</div>
          <p className="mb-1.5 mt-1.5 text-[13px] text-[#6b6f66]">
            {member ? `${member.first} ${member.last}` : "The new member"} signed the membership
            agreement and their account is ready.
          </p>
          {member && (
            <div className="my-5 inline-block rounded-[9px] border border-border bg-muted px-2.5 py-2.5 font-mono text-[13px]">
              Member code · {member.code}
            </div>
          )}
          <div className="flex justify-center gap-2.5">
            <Link
              href={`/${clubSlug}/members/register`}
              className="rounded-[9px] border border-input bg-muted px-[18px] py-2.5 text-[13px] text-[#4a4e45]"
            >
              Register another
            </Link>
            <Link
              href={`/${clubSlug}`}
              className="rounded-[9px] px-5 py-2.5 text-[13px] font-semibold text-white"
              style={{ background: "var(--primary)" }}
            >
              Back to dashboard
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 6: Verify**

```bash
pnpm exec tsc --noEmit
pnpm build
```

Expected: both succeed. Build's route table lists `/[clubSlug]/members/register/sign/[memberId]` and `/[clubSlug]/members/register/success`.

- [ ] **Step 7: Commit**

```bash
git add src/components/sign "src/app/[clubSlug]/members/register/sign" "src/app/[clubSlug]/members/register/success"
git commit -m "Add signature pad, Sign Agreement step, and registration success page"
```

---

### Task 5: Contract template builder route

**Files:**
- Create: `src/app/[clubSlug]/settings/contract/page.tsx`
- Create: `src/app/[clubSlug]/settings/contract/contract-editor.tsx`
- Create: `src/app/[clubSlug]/settings/contract/actions.ts`

**Interfaces:**
- Consumes: `resolveClubAccess` (phase 2), `getOrCreateContractTemplate`/`saveContractTemplate`/`resetContractTemplate` (Task 1), `useClub`/`usePageHeader`/`useToast` (phase 3)
- Produces: the `/[clubSlug]/settings/contract` route — already linked from the phase-3 Sidebar's Settings nav group

- [ ] **Step 1: Write the page**

Create `src/app/[clubSlug]/settings/contract/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import { getOrCreateContractTemplate } from "@/lib/contracts";
import { ContractEditor } from "./contract-editor";

export default async function ContractTemplatePage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const supabase = await createClient();
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();

  const template = await getOrCreateContractTemplate(supabase, access.clubId, access.name);

  return <ContractEditor initialTemplate={template} />;
}
```

- [ ] **Step 2: Write the server actions**

Create `src/app/[clubSlug]/settings/contract/actions.ts`:

```ts
"use server";

import { createClient } from "@/lib/supabase/server";
import {
  saveContractTemplate,
  resetContractTemplate,
  type ContractClause,
  type ContractTemplate,
} from "@/lib/contracts";

export async function saveContractTemplateAction(
  clubId: string,
  input: { title: string; subtitle: string; consent: string; clauses: ContractClause[] },
): Promise<{ ok: true; template: ContractTemplate } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const template = await saveContractTemplate(supabase, clubId, input);
    return { ok: true, template };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to save" };
  }
}

export async function resetContractTemplateAction(
  clubId: string,
  clubName: string,
): Promise<{ ok: true; template: ContractTemplate } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const template = await resetContractTemplate(supabase, clubId, clubName);
    return { ok: true, template };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to reset" };
  }
}
```

- [ ] **Step 3: Write the editor**

Create `src/app/[clubSlug]/settings/contract/contract-editor.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useClub } from "@/lib/club-context";
import { usePageHeader } from "@/lib/page-header-context";
import { useToast } from "@/lib/toast-context";
import { saveContractTemplateAction, resetContractTemplateAction } from "./actions";
import type { ContractClause, ContractTemplate } from "@/lib/contracts";

export function ContractEditor({ initialTemplate }: { initialTemplate: ContractTemplate }) {
  const club = useClub();
  const { showToast } = useToast();
  usePageHeader({
    title: "Membership agreement",
    subtitle: "Shown to every new member at registration and signed before their first dispense.",
  });

  const [title, setTitle] = useState(initialTemplate.title);
  const [subtitle, setSubtitle] = useState(initialTemplate.subtitle);
  const [consent, setConsent] = useState(initialTemplate.consent);
  const [clauses, setClauses] = useState<ContractClause[]>(initialTemplate.clauses);
  const [saving, setSaving] = useState(false);

  function updateClause(index: number, field: "heading" | "body", value: string) {
    setClauses((prev) => prev.map((c, i) => (i === index ? { ...c, [field]: value } : c)));
  }

  function addClause() {
    setClauses((prev) => [...prev, { heading: "", body: "" }]);
  }

  function removeClause(index: number) {
    setClauses((prev) => prev.filter((_, i) => i !== index));
  }

  function moveClause(index: number, direction: -1 | 1) {
    setClauses((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    const result = await saveContractTemplateAction(club.clubId, { title, subtitle, consent, clauses });
    setSaving(false);
    if (result.ok) {
      showToast("Template saved");
    } else {
      showToast(result.error, "error");
    }
  }

  async function handleReset() {
    setSaving(true);
    const result = await resetContractTemplateAction(club.clubId, club.name);
    setSaving(false);
    if (result.ok) {
      setTitle(result.template.title);
      setSubtitle(result.template.subtitle);
      setConsent(result.template.consent);
      setClauses(result.template.clauses);
      showToast("Template reset to default");
    } else {
      showToast(result.error, "error");
    }
  }

  return (
    <div className="grid grid-cols-2 items-start gap-4">
      <div className="rounded-card border border-border bg-card p-5">
        <div className="mb-1 flex items-center gap-2.5">
          <div className="font-heading text-lg font-bold">Membership agreement</div>
          <span className="ml-auto rounded-[5px] bg-accent px-2 py-0.5 font-mono text-[10.5px] text-[var(--status-active-fg)]">
            {club.name}
          </span>
        </div>
        <p className="mb-4 text-[12.5px] text-[#6b6f66]">Each club maintains its own version.</p>

        <label className="mb-1 block text-[11px] text-[#8a8e83]">Agreement title</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="mb-3 w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px]"
        />
        <label className="mb-1 block text-[11px] text-[#8a8e83]">Subtitle / preamble</label>
        <textarea
          value={subtitle}
          onChange={(e) => setSubtitle(e.target.value)}
          rows={2}
          className="w-full rounded-[9px] border border-input px-3 py-2.5 text-[13px] leading-relaxed"
        />

        <div className="mb-2.5 mt-5 flex items-center">
          <div className="font-heading text-sm font-semibold">Clauses</div>
          <span className="ml-2 font-mono text-[10.5px] text-[#8a8e83]">{clauses.length}</span>
        </div>
        {clauses.map((clause, index) => (
          <div key={index} className="mb-2.5 rounded-[11px] border border-border bg-muted p-3">
            <div className="mb-2 flex items-center gap-1.5">
              <span className="font-mono text-xs font-semibold text-[var(--status-active-fg)]">
                {index + 1}
              </span>
              <input
                value={clause.heading}
                onChange={(e) => updateClause(index, "heading", e.target.value)}
                placeholder="Clause heading"
                className="min-w-0 flex-1 rounded-[7px] border border-input bg-card px-2.5 py-1.5 text-[12.5px] font-semibold"
              />
              <button
                type="button"
                onClick={() => moveClause(index, -1)}
                title="Move up"
                className="h-[26px] w-[26px] rounded-[6px] border border-input bg-card text-xs text-[#8a8e83]"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => moveClause(index, 1)}
                title="Move down"
                className="h-[26px] w-[26px] rounded-[6px] border border-input bg-card text-xs text-[#8a8e83]"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => removeClause(index)}
                title="Remove clause"
                className="h-[26px] w-[26px] rounded-[6px] border border-input bg-card text-xs text-destructive"
              >
                ✕
              </button>
            </div>
            <textarea
              value={clause.body}
              onChange={(e) => updateClause(index, "body", e.target.value)}
              placeholder="Clause text…"
              rows={3}
              className="w-full rounded-[7px] border border-input bg-card px-2.5 py-2 text-[12.5px] leading-relaxed"
            />
          </div>
        ))}
        <button
          type="button"
          onClick={addClause}
          className="w-full rounded-[10px] border border-dashed border-[var(--border-dashed)] py-2.5 text-[12.5px] text-[#6b6f66]"
        >
          + Add clause
        </button>

        <label className="mb-1 mt-4 block text-[11px] text-[#8a8e83]">
          Consent statement (shown beside the signature checkbox)
        </label>
        <textarea
          value={consent}
          onChange={(e) => setConsent(e.target.value)}
          rows={2}
          className="w-full rounded-[9px] border border-input px-3 py-2.5 text-[12.5px] leading-relaxed"
        />

        <div className="mt-5 flex gap-2.5">
          <button
            type="button"
            onClick={handleReset}
            disabled={saving}
            className="rounded-[9px] border border-input bg-muted px-4 py-2.5 text-[13px] text-[#4a4e45]"
          >
            Reset to default
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="ml-auto rounded-[9px] px-5 py-2.5 text-[13px] font-semibold text-white"
            style={{ background: "var(--primary)" }}
          >
            Save template
          </button>
        </div>
      </div>

      <div className="sticky top-0">
        <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[.08em] text-[#8a8e83]">
          Member-facing preview
        </div>
        <div className="overflow-hidden rounded-card border border-border bg-card">
          <div className="px-[22px] pb-1.5 pt-5">
            <div className="font-heading text-[17px] font-bold">{title}</div>
            <div className="mt-1 whitespace-pre-line text-xs text-[#6b6f66]">{subtitle}</div>
          </div>
          <div className="mx-[22px] mt-3 max-h-[360px] overflow-y-auto border-t border-[#efece3] pt-3.5">
            {clauses.map((clause, index) => (
              <div key={index} className="mb-3">
                <div className="font-heading text-[13px] font-semibold">
                  {index + 1}. {clause.heading}
                </div>
                <div className="mt-0.5 whitespace-pre-line text-xs leading-[1.55] text-[#4a4e45]">
                  {clause.body}
                </div>
              </div>
            ))}
          </div>
          <div className="mx-[22px] mb-5 border-t border-[#efece3] pt-3.5">
            <label className="flex items-start gap-2 text-[11.5px] text-[#6b6f66]">
              <span className="mt-0.5 h-[15px] w-[15px] flex-none rounded border-[1.5px] border-[var(--border-dashed)]" />
              <span>{consent}</span>
            </label>
            <div className="mt-3 flex h-14 items-center rounded-[9px] border border-border px-3.5 font-serif text-xl italic text-[#c4c0b3]">
              Signature
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Verify**

```bash
pnpm exec tsc --noEmit
pnpm build
```

Expected: both succeed. Build's route table lists `/[clubSlug]/settings/contract`.

- [ ] **Step 5: Run the full test suite one more time**

```bash
pnpm test
```

Expected: same pass/fail profile as Task 2's Step 5.

- [ ] **Step 6: Commit**

```bash
git add "src/app/[clubSlug]/settings/contract"
git commit -m "Add contract template builder route"
```

---

## End of phase 4

Stop here for review. What this phase proves end-to-end: a staff member can register a new member, review and sign that club's actual (possibly customized) agreement with a real finger/pencil-drawn signature on an iPad, and the result is a genuine, immutable, snapshotted audit record in `signed_contracts` with a real Storage-hosted signature image — provably reproducing what was shown at sign time, not just a reference to a template that could later change. The builder lets each club customize their agreement independently, exactly as the spec requires. Phase 5 (remaining screens) is next.
