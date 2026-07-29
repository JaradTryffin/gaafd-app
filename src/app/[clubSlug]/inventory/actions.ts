"use server";

import { createClient } from "@/lib/supabase/server";
import { createMovement, type CreateMovementInput, type Movement } from "@/lib/inventory";

export async function createMovementAction(
  clubId: string,
  input: CreateMovementInput,
): Promise<{ ok: true; movement: Movement; newStock: number } | { ok: false; error: string }> {
  const supabase = await createClient();
  try {
    const { movement, newStock } = await createMovement(supabase, clubId, input);
    return { ok: true, movement, newStock };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to log movement" };
  }
}
