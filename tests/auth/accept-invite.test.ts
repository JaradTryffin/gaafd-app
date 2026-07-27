import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

let createdUserId: string | null = null;

afterEach(async () => {
  // Runs regardless of whether the test's own assertions passed or threw,
  // so a failed expect() partway through doesn't leak a real auth user on
  // the live project (unlike relying on cleanup at the end of the it body).
  if (createdUserId) {
    const admin = createAdminClient();
    await admin.auth.admin.deleteUser(createdUserId);
    createdUserId = null;
  }
});

describe("accept-invite mechanism: verifyOtp redeems a real invite token", () => {
  it("a generated invite link's token can be redeemed, establishing a session", async () => {
    const admin = createAdminClient();
    // Supabase's built-in email provider validates recipient deliverability and
    // rejects RFC-2606 reserved test domains (example.com/example.test) outright
    // with email_address_invalid — mailinator.com is a real, publicly-deliverable
    // disposable inbox domain, matching the reasoning already used in
    // tests/auth/invites.test.ts for this exact issue.
    const email = `gaafd-rls-confirm-${crypto.randomUUID().slice(0, 8)}@mailinator.com`;

    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: "invite",
      email,
    });
    if (linkError) throw linkError;
    createdUserId = linkData.user.id;

    // Confirmed against node_modules/.pnpm/@supabase+auth-js@2.110.8's
    // GenerateLinkProperties type: the field is `hashed_token`.
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
  }, 30000);
});
