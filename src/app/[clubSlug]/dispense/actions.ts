"use server";

import { createClient } from "@/lib/supabase/server";
import { createDispenseOrder, type CartItem, type DispenseOrder } from "@/lib/dispensing";

export async function createDispenseOrderAction(
  clubId: string,
  memberId: string,
  items: CartItem[],
): Promise<{ ok: true; order: DispenseOrder } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const order = await createDispenseOrder(supabase, clubId, memberId, items);
    return { ok: true, order };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to complete dispense" };
  }
}
