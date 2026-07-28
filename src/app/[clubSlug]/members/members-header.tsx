"use client";

import { usePageHeader } from "@/lib/page-header-context";

export function MembersHeader({ clubName, count }: { clubName: string; count: number }) {
  usePageHeader({ title: "Members", subtitle: `${count} registered · ${clubName}` });
  return null;
}
