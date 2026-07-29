"use client";

import { usePageHeader } from "@/lib/page-header-context";

export function InventoryHeader() {
  usePageHeader({ title: "Inventory", subtitle: "Append-only stock movement ledger" });
  return null;
}
