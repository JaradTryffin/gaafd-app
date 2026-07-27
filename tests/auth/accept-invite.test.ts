import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

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

    if (verifyData.user) {
      await admin.auth.admin.deleteUser(verifyData.user.id);
    }
  }, 30000);
});
