"use server";

import { createClient } from "@/lib/supabase/server";
import { recordDonation, type RecordDonationInput, type Donation } from "@/lib/donations";

export async function recordDonationAction(
  clubId: string,
  input: RecordDonationInput,
): Promise<{ ok: true; donation: Donation } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const donation = await recordDonation(supabase, clubId, input);
    return { ok: true, donation };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to record donation" };
  }
}
