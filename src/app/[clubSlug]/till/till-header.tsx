"use client";

import { usePageHeader } from "@/lib/page-header-context";

export function TillHeader() {
  usePageHeader({ title: "Till & shifts", subtitle: "Daily cash handling" });
  return null;
}
