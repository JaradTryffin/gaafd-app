"use client";

import { useClub } from "@/lib/club-context";
import { usePageHeader } from "@/lib/page-header-context";

// Placeholder until phase 5 builds the real Dashboard screen (KPI cards,
// activity feed, low-stock alerts). Proves the shell — sidebar, header,
// context — renders real per-page content correctly.
export default function ClubIndexPage() {
  const club = useClub();
  usePageHeader({
    title: "Dashboard",
    subtitle: `${club.name} · signed in as ${club.role}`,
  });

  return (
    <div className="rounded-card border border-border bg-card p-6">
      <p className="text-sm text-[#6b6f66]">
        The real dashboard (KPI cards, activity, low-stock alerts) lands in phase 5.
      </p>
    </div>
  );
}
