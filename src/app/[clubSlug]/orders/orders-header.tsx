"use client";

import { usePageHeader } from "@/lib/page-header-context";

export function OrdersHeader() {
  usePageHeader({ title: "Order history", subtitle: "Every checkout, including gifts" });
  return null;
}
