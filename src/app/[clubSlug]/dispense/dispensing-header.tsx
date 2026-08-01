"use client";

import { usePageHeader } from "@/lib/page-header-context";

export function DispensingHeader() {
  usePageHeader({ title: "Dispensing", subtitle: "Redeem member tokens for product" });
  return null;
}
