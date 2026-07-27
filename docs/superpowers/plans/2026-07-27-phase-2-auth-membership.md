# GaafD Phase 2 — Auth + Club Membership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Invite-only email+password auth (no public signup anywhere), `club_users`/`platform_users` wiring, active-club resolution via the `/[clubSlug]/...` route segment, and role gating for both club and platform routes — the foundation phase 3 (app shell) and every later screen builds on.

**Architecture:** Supabase Auth handles credentials; two thin `"use server"` action layers wrap testable core logic (`src/lib/invites.ts`, `src/lib/auth/landing.ts`) so authorization rules are unit-testable without a browser. Route protection lives in layouts (`[clubSlug]/layout.tsx`, `platform/layout.tsx`), not middleware — middleware's only job is session-cookie refresh, per Supabase's own recommended split.

**Tech Stack:** Supabase Auth (email+password, admin invite API), Next.js Server Actions + Route Handlers, `@supabase/ssr`, Vitest against the live cloud project (same pattern as phase 1).

## Global Constraints

- Reuse `src/lib/supabase/client.ts`, `src/lib/supabase/server.ts`, `src/lib/supabase/admin.ts`, and `tests/rls/fixtures.ts` exactly as they are from phases 0-1 — do not modify them unless a task explicitly says so.
- Package manager: pnpm exclusively. Node 24.18.0 via `.nvmrc` (`export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use` before running anything).
- Commit messages: plain, imperative. Work on branch `master` directly (standing consent from phases 0-1).
- Tests hit the live Supabase project (ref `inlseklfbptgjketdnpe`) — same live-infrastructure pattern as phase 1's isolation suite, not mocks.
- **Every server action derives caller identity from the authenticated session server-side (`supabase.auth.getUser()`), never from a client-supplied user/club id.** A client-supplied id may say *which resource* is being acted on; it must never be trusted for *who is asking*.
- No public signup route anywhere — every account is created via `auth.admin.createUser`/`inviteUserByEmail` from a service-role context, gated by an authorization check.

---

## File Structure

- `src/lib/supabase/middleware.ts`, `src/middleware.ts` — session refresh only (Task 1).
- `src/lib/invites.ts`, `tests/auth/invites.test.ts` — core invite/onboarding authorization logic (Task 2).
- `src/lib/auth/landing.ts`, `src/lib/auth/actions.ts`, `src/app/login/{page.tsx,actions.ts}`, `src/app/page.tsx` (modified) — sign-in and post-login routing (Task 3).
- `src/app/auth/confirm/route.ts`, `src/app/accept-invite/set-password/{page.tsx,actions.ts}`, `tests/auth/accept-invite.test.ts`, `supabase/config.toml` (modified) — invite redemption (Task 4).
- `src/lib/club-context.tsx`, `src/app/[clubSlug]/{layout.tsx,page.tsx}`, `src/app/platform/{layout.tsx,page.tsx}`, `src/app/select-club/page.tsx`, `src/app/no-access/page.tsx` — route/role gating (Task 5).

---

### Task 1: Middleware for session refresh

**Files:**
- Create: `src/lib/supabase/middleware.ts`
- Create: `src/middleware.ts`

**Interfaces:**
- Consumes: nothing new (env vars already wired from phase 0)
- Produces: automatic session-cookie refresh on every request — every later task's server-side auth checks rely on this running, but nothing calls it directly

- [ ] **Step 1: Write the session-refresh helper**

Create `src/lib/supabase/middleware.ts`:

```ts
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Refreshes the auth session cookie on every request. Server Components can
// only read cookies, not write them — this is why the session is refreshed
// here rather than in each page/layout (see the comment in
// src/lib/supabase/server.ts, which has been pointing at this file's
// existence since phase 0).
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Touching auth.getUser() is what actually triggers a token refresh when
  // the access token has expired but the refresh token is still valid.
  await supabase.auth.getUser();

  return supabaseResponse;
}
```

- [ ] **Step 2: Write the middleware entry point**

Create `src/middleware.ts`:

```ts
import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
```

Middleware deliberately does **not** redirect unauthenticated users anywhere — it only keeps sessions fresh. Route protection (redirecting to `/login`, 404ing on missing club access) is each layout's job in later tasks, not middleware's.

- [ ] **Step 3: Verify**

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use
cd /Users/user/Documents/projects/gaafd-app
pnpm exec tsc --noEmit
pnpm build
```

Expected: both succeed with no errors. `pnpm build` should list `middleware` in its output (Next.js reports middleware size/presence in the build summary).

- [ ] **Step 4: Commit**

```bash
git add src/lib/supabase/middleware.ts src/middleware.ts
git commit -m "Add session-refresh middleware"
```

---

### Task 2: Core invite/onboarding logic + authorization tests

**Files:**
- Create: `src/lib/invites.ts`
- Create: `tests/auth/invites.test.ts`

**Interfaces:**
- Consumes: `createAdminClient` from `src/lib/supabase/admin.ts` (phase 1); `seedTenants`, `cleanupTenants`, `signInAs`, `type SeededData` from `tests/rls/fixtures.ts` (phase 1)
- Produces: `inviteStaffToClub(supabase: SupabaseClient, clubId: string, staffEmail: string): Promise<{ userId: string }>` and `createClubAndInviteAdmin(supabase: SupabaseClient, input: { slug: string; name: string; initials: string; plan: "Trial" | "Starter" | "Growth" | "Enterprise"; region: string; accentColor: string; adminEmail: string }): Promise<{ clubId: string; adminUserId: string }>` from `src/lib/invites.ts` — consumed by Task 3's login flow indirectly (no) and directly by future server action wrappers in phases 3/5 that add UI for these

- [ ] **Step 1: Write the core invite/onboarding module**

Create `src/lib/invites.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

export async function inviteStaffToClub(
  supabase: SupabaseClient,
  clubId: string,
  staffEmail: string,
): Promise<{ userId: string }> {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    throw new Error("Not authenticated");
  }

  const { data: membership, error: membershipError } = await supabase
    .from("club_users")
    .select("role")
    .eq("club_id", clubId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (membershipError) throw membershipError;
  if (membership?.role !== "admin") {
    throw new Error("Only a club admin can invite staff into this club");
  }

  const admin = createAdminClient();
  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(
    staffEmail,
  );
  if (inviteError) throw inviteError;

  const { error: insertError } = await admin.from("club_users").insert({
    club_id: clubId,
    user_id: invited.user.id,
    role: "staff",
  });
  if (insertError) throw insertError;

  return { userId: invited.user.id };
}

export async function createClubAndInviteAdmin(
  supabase: SupabaseClient,
  input: {
    slug: string;
    name: string;
    initials: string;
    plan: "Trial" | "Starter" | "Growth" | "Enterprise";
    region: string;
    accentColor: string;
    adminEmail: string;
  },
): Promise<{ clubId: string; adminUserId: string }> {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    throw new Error("Not authenticated");
  }

  const { data: platformRow, error: platformError } = await supabase
    .from("platform_users")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (platformError) throw platformError;
  if (!platformRow) {
    throw new Error("Only the platform operator can onboard a new club");
  }

  const admin = createAdminClient();
  const { data: club, error: clubError } = await admin
    .from("clubs")
    .insert({
      slug: input.slug,
      name: input.name,
      initials: input.initials,
      plan: input.plan,
      region: input.region,
      accent_color: input.accentColor,
      status: "trial",
    })
    .select()
    .single();
  if (clubError) throw clubError;

  try {
    const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(
      input.adminEmail,
    );
    if (inviteError) throw inviteError;

    const { error: insertError } = await admin.from("club_users").insert({
      club_id: club.id,
      user_id: invited.user.id,
      role: "admin",
    });
    if (insertError) throw insertError;

    return { clubId: club.id, adminUserId: invited.user.id };
  } catch (err) {
    // Roll back the club row so a partial failure doesn't leave an
    // orphaned, admin-less club behind.
    await admin.from("clubs").delete().eq("id", club.id);
    throw err;
  }
}
```

- [ ] **Step 2: Write the authorization test suite**

Create `tests/auth/invites.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { seedTenants, cleanupTenants, signInAs, type SeededData } from "../rls/fixtures";
import { inviteStaffToClub, createClubAndInviteAdmin } from "@/lib/invites";

const PASSWORD = "Test-Password-123!";

let data: SeededData;
let clubAClient: SupabaseClient;
let clubBClient: SupabaseClient;
let platformClient: SupabaseClient;
const cleanupUserIds: string[] = [];
const cleanupClubIds: string[] = [];

beforeAll(async () => {
  data = await seedTenants();
  clubAClient = await signInAs(data.clubA.adminEmail, data.clubA.adminPassword);
  clubBClient = await signInAs(data.clubB.adminEmail, data.clubB.adminPassword);
  platformClient = await signInAs(data.platformEmail, data.platformPassword);
}, 30000);

afterAll(async () => {
  const admin = createAdminClient();
  for (const userId of cleanupUserIds) {
    await admin.auth.admin.deleteUser(userId);
  }
  for (const clubId of cleanupClubIds) {
    await admin.from("clubs").delete().eq("id", clubId);
  }
  if (data) {
    await cleanupTenants(data);
  }
}, 30000);

describe("inviteStaffToClub", () => {
  it("club admin can invite staff into their own club", async () => {
    const email = `rls-invite-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const { userId } = await inviteStaffToClub(clubAClient, data.clubA.clubId, email);
    cleanupUserIds.push(userId);

    const admin = createAdminClient();
    const { data: membership } = await admin
      .from("club_users")
      .select("role")
      .eq("club_id", data.clubA.clubId)
      .eq("user_id", userId)
      .single();
    expect(membership?.role).toBe("staff");
  });

  it("club admin cannot invite staff into a different club", async () => {
    const email = `rls-invite-${crypto.randomUUID().slice(0, 8)}@example.test`;
    await expect(inviteStaffToClub(clubAClient, data.clubB.clubId, email)).rejects.toThrow();
  });

  it("a staff-role caller cannot invite staff at all", async () => {
    const staffEmail = `rls-staffcaller-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const admin = createAdminClient();
    const { data: staffAuth, error: staffAuthError } = await admin.auth.admin.createUser({
      email: staffEmail,
      password: PASSWORD,
      email_confirm: true,
    });
    if (staffAuthError) throw staffAuthError;
    cleanupUserIds.push(staffAuth.user.id);

    const { error: staffInsertError } = await admin.from("club_users").insert({
      club_id: data.clubA.clubId,
      user_id: staffAuth.user.id,
      role: "staff",
    });
    if (staffInsertError) throw staffInsertError;

    const staffClient = await signInAs(staffEmail, PASSWORD);
    const email = `rls-invite-${crypto.randomUUID().slice(0, 8)}@example.test`;
    await expect(inviteStaffToClub(staffClient, data.clubA.clubId, email)).rejects.toThrow();
  });

  it("a platform-only caller cannot invite staff via this path", async () => {
    const email = `rls-invite-${crypto.randomUUID().slice(0, 8)}@example.test`;
    await expect(inviteStaffToClub(platformClient, data.clubA.clubId, email)).rejects.toThrow();
  });
});

describe("createClubAndInviteAdmin", () => {
  it("platform user can onboard a new club with its first admin", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const adminEmail = `rls-newclub-admin-${suffix}@example.test`;
    const { clubId, adminUserId } = await createClubAndInviteAdmin(platformClient, {
      slug: `rls-newclub-${suffix}`,
      name: `RLS New Club ${suffix}`,
      initials: "NC",
      plan: "Trial",
      region: "Test Region",
      accentColor: "#3f7a4e",
      adminEmail,
    });
    cleanupClubIds.push(clubId);
    cleanupUserIds.push(adminUserId);

    const admin = createAdminClient();
    const { data: membership } = await admin
      .from("club_users")
      .select("role")
      .eq("club_id", clubId)
      .eq("user_id", adminUserId)
      .single();
    expect(membership?.role).toBe("admin");
  });

  it("a club admin (non-platform) cannot onboard a new club", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    await expect(
      createClubAndInviteAdmin(clubAClient, {
        slug: `rls-rejected-${suffix}`,
        name: "Should Not Exist",
        initials: "XX",
        plan: "Trial",
        region: "Test Region",
        accentColor: "#000000",
        adminEmail: `rls-rejected-${suffix}@example.test`,
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run it**

```bash
pnpm exec vitest run tests/auth/invites.test.ts
```

Expected: `6 passed`. This hits the live Supabase project.

- [ ] **Step 4: Run the full suite**

```bash
pnpm test
```

Expected: everything still passes (phase 1's suites + this new one).

- [ ] **Step 5: Commit**

```bash
git add src/lib/invites.ts tests/auth/invites.test.ts
git commit -m "Add invite/onboarding logic with server-side authorization checks"
```

---

### Task 3: Landing resolution + login + root redirect

**Files:**
- Create: `src/lib/auth/landing.ts`
- Create: `src/lib/auth/actions.ts`
- Create: `src/app/login/actions.ts`
- Create: `src/app/login/page.tsx`
- Modify: `src/app/page.tsx`

**Interfaces:**
- Consumes: `createClient` from `src/lib/supabase/server.ts` (phase 0)
- Produces: `resolveLandingPath(supabase: SupabaseClient): Promise<string>` from `src/lib/auth/landing.ts` — consumed by Task 4's set-password action and Task 3's own login action/root page; `signOut(): Promise<never>` from `src/lib/auth/actions.ts` — consumed by Task 5's placeholder pages

- [ ] **Step 1: Write the landing-path resolver**

Create `src/lib/auth/landing.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

export async function resolveLandingPath(supabase: SupabaseClient): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "/login";

  const { data: platformRow } = await supabase
    .from("platform_users")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (platformRow) return "/platform";

  const { data: memberships } = await supabase
    .from("club_users")
    .select("club_id")
    .eq("user_id", user.id);
  const clubIds = (memberships ?? []).map((m) => m.club_id);

  if (clubIds.length === 0) return "/no-access";

  const { data: clubs } = await supabase.from("clubs").select("slug").in("id", clubIds);
  const slugs = (clubs ?? []).map((c) => c.slug);

  if (slugs.length === 1) return `/${slugs[0]}`;
  return "/select-club";
}
```

- [ ] **Step 2: Write the sign-out action**

Create `src/lib/auth/actions.ts`:

```ts
"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
```

- [ ] **Step 3: Write the login server action**

Create `src/app/login/actions.ts`:

```ts
"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveLandingPath } from "@/lib/auth/landing";

export async function login(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }

  const landingPath = await resolveLandingPath(supabase);
  redirect(landingPath);
}
```

- [ ] **Step 4: Write the login page**

Create `src/app/login/page.tsx`:

```tsx
import { login } from "./actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div style={{ maxWidth: 360, margin: "80px auto", fontFamily: "sans-serif" }}>
      <h1>Sign in</h1>
      {error && <p style={{ color: "#b4432f" }}>{error}</p>}
      <form action={login} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <label htmlFor="email">Email</label>
          <br />
          <input id="email" name="email" type="email" required style={{ width: "100%" }} />
        </div>
        <div>
          <label htmlFor="password">Password</label>
          <br />
          <input
            id="password"
            name="password"
            type="password"
            required
            style={{ width: "100%" }}
          />
        </div>
        <button type="submit">Sign in</button>
      </form>
    </div>
  );
}
```

This is deliberately unstyled — it's not one of the design reference's mocked screens, and phase 3's app shell won't restyle it either (login sits outside the club-scoped shell). Functional now, cosmetic polish later if ever needed.

- [ ] **Step 5: Redirect the root route**

Replace the contents of `src/app/page.tsx` with:

```tsx
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveLandingPath } from "@/lib/auth/landing";

export default async function RootPage() {
  const supabase = await createClient();
  const path = await resolveLandingPath(supabase);
  redirect(path);
}
```

This replaces the create-next-app boilerplate that's been sitting there since phase 0 (flagged as a known follow-up in the phase-0 review ledger) with the first real use of the root route.

- [ ] **Step 6: Verify**

```bash
pnpm exec tsc --noEmit
pnpm build
```

Expected: both succeed. `pnpm build`'s route table should list `/`, `/login` (and no longer reference `next.svg`/`vercel.svg` imports from the old page).

- [ ] **Step 7: Commit**

```bash
git add src/lib/auth/landing.ts src/lib/auth/actions.ts src/app/login/actions.ts src/app/login/page.tsx src/app/page.tsx
git commit -m "Add login flow and post-login landing resolution"
```

---

### Task 4: Accept-invite flow

**Files:**
- Create: `src/app/auth/confirm/route.ts`
- Create: `src/app/accept-invite/set-password/actions.ts`
- Create: `src/app/accept-invite/set-password/page.tsx`
- Create: `tests/auth/accept-invite.test.ts`
- Modify: `supabase/config.toml`

**Interfaces:**
- Consumes: `createClient` from `src/lib/supabase/server.ts`; `resolveLandingPath` from `src/lib/auth/landing.ts` (Task 3); `createAdminClient` from `src/lib/supabase/admin.ts`
- Produces: the `/auth/confirm` redemption endpoint every invite email link points at — consumed by real users clicking a real invite email, and by this task's own mechanism test

- [ ] **Step 1: Write the invite-redemption route handler**

Create `src/app/auth/confirm/route.ts`:

```ts
import type { EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = searchParams.get("next") ?? "/accept-invite/set-password";

  if (token_hash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) {
      redirect(next);
    }
  }

  redirect("/login?error=Invalid%20or%20expired%20invite%20link");
}
```

Check the installed `@supabase/supabase-js` version exports `EmailOtpType` from its root — if the type has moved or been renamed, use whatever the installed version's `verifyOtp` signature actually expects for its `type` parameter (check the package's `.d.ts` files under `node_modules/@supabase/supabase-js` rather than guessing).

- [ ] **Step 2: Write the set-password action**

Create `src/app/accept-invite/set-password/actions.ts`:

```ts
"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveLandingPath } from "@/lib/auth/landing";

export async function setPassword(formData: FormData) {
  const password = String(formData.get("password") ?? "");

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    redirect(`/accept-invite/set-password?error=${encodeURIComponent(error.message)}`);
  }

  const landingPath = await resolveLandingPath(supabase);
  redirect(landingPath);
}
```

- [ ] **Step 3: Write the set-password page**

Create `src/app/accept-invite/set-password/page.tsx`:

```tsx
import { setPassword } from "./actions";

export default async function SetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div style={{ maxWidth: 360, margin: "80px auto", fontFamily: "sans-serif" }}>
      <h1>Set your password</h1>
      {error && <p style={{ color: "#b4432f" }}>{error}</p>}
      <form action={setPassword} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <label htmlFor="password">New password</label>
          <br />
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={6}
            style={{ width: "100%" }}
          />
        </div>
        <button type="submit">Set password and continue</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: Configure the auth redirect allowlist**

Read the current `[auth]` section of `supabase/config.toml` first — it currently has `site_url = "http://127.0.0.1:3000"` and `additional_redirect_urls = ["https://127.0.0.1:3000"]` (from the default scaffold, unused so far since no auth flow existed before this task). Update it to:

```toml
site_url = "http://localhost:3000"
additional_redirect_urls = ["http://localhost:3000/**"]
```

Then check whether the installed Supabase CLI can push this to the linked cloud project:

```bash
cd /Users/user/Documents/projects/gaafd-app
supabase config push --help
```

If it supports pushing to a linked remote project, run it (following whatever the actual current flag syntax is — this project has repeatedly found CLI versions newer than expected, so check `--help`'s real output rather than assuming). If `config push` doesn't exist or doesn't support auth settings in the installed CLI version, note this clearly in your report as a manual follow-up: the user will need to set the Site URL and Redirect URLs in the Supabase dashboard (Authentication → URL Configuration) for `https://inlseklfbptgjketdnpe.supabase.co` themselves. Don't guess at dashboard steps you can't verify — just flag it.

- [ ] **Step 5: Write the mechanism test**

Create `tests/auth/accept-invite.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

describe("accept-invite mechanism: verifyOtp redeems a real invite token", () => {
  it("a generated invite link's token can be redeemed, establishing a session", async () => {
    const admin = createAdminClient();
    const email = `rls-invite-mech-${crypto.randomUUID().slice(0, 8)}@example.test`;

    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: "invite",
      email,
    });
    if (linkError) throw linkError;

    // Confirm the actual field name on the installed @supabase/supabase-js
    // version before trusting this — check GenerateLinkResponse's type in
    // node_modules/@supabase/supabase-js if this assertion fails.
    const tokenHash = linkData.properties.hashed_token;
    expect(tokenHash).toBeTruthy();

    const anon = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    const { data: verifyData, error: verifyError } = await anon.auth.verifyOtp({
      type: "invite",
      token_hash: tokenHash,
    });
    expect(verifyError).toBeNull();
    expect(verifyData.session).not.toBeNull();
    expect(verifyData.user?.email).toBe(email);

    if (verifyData.user) {
      await admin.auth.admin.deleteUser(verifyData.user.id);
    }
  }, 30000);
});
```

- [ ] **Step 6: Run it**

```bash
pnpm exec vitest run tests/auth/accept-invite.test.ts
```

Expected: `1 passed`. If `generateLink`'s response shape differs from `linkData.properties.hashed_token`, read the actual type from `node_modules/@supabase/supabase-js`'s `.d.ts` files and adjust — do not guess a second time, inspect the real type.

- [ ] **Step 7: Verify build and full suite**

```bash
pnpm exec tsc --noEmit
pnpm build
pnpm test
```

Expected: all clean, all passing.

- [ ] **Step 8: Commit**

```bash
git add src/app/auth/confirm/route.ts src/app/accept-invite/set-password/actions.ts src/app/accept-invite/set-password/page.tsx tests/auth/accept-invite.test.ts supabase/config.toml
git commit -m "Add invite-redemption flow and configure auth redirect allowlist"
```

---

### Task 5: Club and platform route gating

**Files:**
- Create: `src/lib/club-context.tsx`
- Create: `src/app/[clubSlug]/layout.tsx`
- Create: `src/app/[clubSlug]/page.tsx`
- Create: `src/app/platform/layout.tsx`
- Create: `src/app/platform/page.tsx`
- Create: `src/app/select-club/page.tsx`
- Create: `src/app/no-access/page.tsx`

**Interfaces:**
- Consumes: `createClient` from `src/lib/supabase/server.ts`; `signOut` from `src/lib/auth/actions.ts` (Task 3)
- Produces: `ClubProvider`, `useClub(): ClubContextValue` from `src/lib/club-context.tsx` — consumed by every club-scoped screen from phase 3 onward

- [ ] **Step 1: Write the club context**

Create `src/lib/club-context.tsx`:

```tsx
"use client";

import { createContext, useContext } from "react";

export type ClubContextValue = {
  clubId: string;
  slug: string;
  name: string;
  initials: string;
  accentColor: string;
  role: "staff" | "admin";
};

const ClubContext = createContext<ClubContextValue | null>(null);

export function ClubProvider({
  value,
  children,
}: {
  value: ClubContextValue;
  children: React.ReactNode;
}) {
  return <ClubContext.Provider value={value}>{children}</ClubContext.Provider>;
}

export function useClub(): ClubContextValue {
  const ctx = useContext(ClubContext);
  if (!ctx) {
    throw new Error("useClub must be used within a ClubProvider");
  }
  return ctx;
}
```

- [ ] **Step 2: Write the club layout (the authorization gate)**

Create `src/app/[clubSlug]/layout.tsx`:

```tsx
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ClubProvider } from "@/lib/club-context";

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

  // RLS already scopes this to clubs the caller can access — a slug for a
  // club they don't belong to comes back empty here, not as a leaked row.
  const { data: club, error: clubError } = await supabase
    .from("clubs")
    .select("id, slug, name, initials, accent_color")
    .eq("slug", clubSlug)
    .maybeSingle();
  if (clubError || !club) {
    notFound();
  }

  // This is the definitive authorization check (not just a formality) — it
  // also gets us the role the rest of the app needs.
  const { data: membership } = await supabase
    .from("club_users")
    .select("role")
    .eq("club_id", club.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership) {
    notFound();
  }

  return (
    <ClubProvider
      value={{
        clubId: club.id,
        slug: club.slug,
        name: club.name,
        initials: club.initials,
        accentColor: club.accent_color,
        role: membership.role as "staff" | "admin",
      }}
    >
      {children}
    </ClubProvider>
  );
}
```

- [ ] **Step 3: Write the club placeholder page**

Create `src/app/[clubSlug]/page.tsx`:

```tsx
"use client";

import { useClub } from "@/lib/club-context";
import { signOut } from "@/lib/auth/actions";

// Placeholder until phase 3 (app shell) and phase 5 (real Dashboard
// screen) land. Proves auth + club resolution + context work end to end.
export default function ClubIndexPage() {
  const club = useClub();
  return (
    <div style={{ maxWidth: 480, margin: "80px auto", fontFamily: "sans-serif" }}>
      <h1>{club.name}</h1>
      <p>Signed in as {club.role}. The real dashboard lands in a later phase.</p>
      <form action={signOut}>
        <button type="submit">Sign out</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: Write the platform layout and placeholder page**

Create `src/app/platform/layout.tsx`:

```tsx
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const { data: platformRow } = await supabase
    .from("platform_users")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!platformRow) {
    notFound();
  }

  return <>{children}</>;
}
```

Create `src/app/platform/page.tsx`:

```tsx
import { signOut } from "@/lib/auth/actions";

// Placeholder until phase 5 builds the real Platform console.
export default function PlatformIndexPage() {
  return (
    <div style={{ maxWidth: 480, margin: "80px auto", fontFamily: "sans-serif" }}>
      <h1>Platform</h1>
      <p>Signed in as platform operator. The real console lands in a later phase.</p>
      <form action={signOut}>
        <button type="submit">Sign out</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 5: Write the select-club and no-access pages**

Create `src/app/select-club/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function SelectClubPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const { data: memberships } = await supabase
    .from("club_users")
    .select("club_id")
    .eq("user_id", user.id);
  const clubIds = (memberships ?? []).map((m) => m.club_id);

  // .in() with an empty array can behave oddly in PostgREST — fall back to
  // a placeholder id that can never match a real row rather than passing [].
  const { data: clubs } = await supabase
    .from("clubs")
    .select("slug, name")
    .in("id", clubIds.length > 0 ? clubIds : ["00000000-0000-0000-0000-000000000000"]);

  return (
    <div style={{ maxWidth: 480, margin: "80px auto", fontFamily: "sans-serif" }}>
      <h1>Select a club</h1>
      <ul>
        {(clubs ?? []).map((c) => (
          <li key={c.slug}>
            <a href={`/${c.slug}`}>{c.name}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

Create `src/app/no-access/page.tsx`:

```tsx
import { signOut } from "@/lib/auth/actions";

// Shouldn't normally be reachable — invites always create a club_users row
// atomically — but handled rather than left to crash.
export default function NoAccessPage() {
  return (
    <div style={{ maxWidth: 480, margin: "80px auto", fontFamily: "sans-serif" }}>
      <h1>No access yet</h1>
      <p>Your account isn&apos;t linked to any club. Contact your club admin.</p>
      <form action={signOut}>
        <button type="submit">Sign out</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 6: Verify**

```bash
pnpm exec tsc --noEmit
pnpm build
```

Expected: both succeed. Build's route table should list `/[clubSlug]`, `/platform`, `/select-club`, `/no-access`.

- [ ] **Step 7: Manual smoke test**

```bash
pnpm dev &
sleep 3
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/login
kill %1
```

Expected: `/` returns a redirect (curl follows by default without `-L`, so expect a 307/303 status unless you add `-L` — either way, not a 500). `/login` returns `200`.

- [ ] **Step 8: Run the full test suite one more time**

```bash
pnpm test
```

Expected: all passing (phase 1 + phase 2's `invites.test.ts` + `accept-invite.test.ts`).

- [ ] **Step 9: Commit**

```bash
git add src/lib/club-context.tsx src/app/[clubSlug] src/app/platform src/app/select-club src/app/no-access
git commit -m "Add club and platform route gating with context"
```

---

## End of phase 2

Stop here for review. What this phase proves end-to-end: an invited user can redeem their invite, set a password, and land on the right page for their role (club placeholder, platform placeholder, or a club picker); an uninvited/unauthenticated visitor is redirected to `/login`; a club admin can invite staff into their own club and nowhere else; only the platform operator can onboard new clubs. Phase 3 replaces every placeholder page's styling with the real app shell (sidebar, workspace switcher, header, toasts) without touching the auth/authorization logic built here.
