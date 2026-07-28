"use client";

import { usePageHeader } from "@/lib/page-header-context";

export function SuccessHeader() {
  usePageHeader({ title: "Registration complete" });
  return null;
}
