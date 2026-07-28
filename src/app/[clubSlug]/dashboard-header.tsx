"use client";

import { usePageHeader } from "@/lib/page-header-context";

export function DashboardHeader({ clubName }: { clubName: string }) {
  usePageHeader({ title: "Dashboard", subtitle: `${clubName} · today` });
  return null;
}
