"use client";

import { usePageHeader } from "@/lib/page-header-context";

export function DonationsHeader() {
  usePageHeader({ title: "Donations", subtitle: "Cash → token conversion" });
  return null;
}
