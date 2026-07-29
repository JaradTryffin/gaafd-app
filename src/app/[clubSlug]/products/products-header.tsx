"use client";

import { usePageHeader } from "@/lib/page-header-context";

export function ProductsHeader({ clubName, count }: { clubName: string; count: number }) {
  usePageHeader({ title: "Products", subtitle: `${count} products · ${clubName}` });
  return null;
}
