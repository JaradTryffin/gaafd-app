"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useClub } from "@/lib/club-context";
import { signOut } from "@/lib/auth/actions";
import type { ClubMembershipSummary } from "@/lib/auth/club-access";

const NAV_GROUPS = [
  {
    label: "Operations",
    items: [
      { key: "dashboard", label: "Dashboard", path: "", dot: "var(--sidebar-accent-dot)" },
      { key: "dispense", label: "Dispensing", path: "/dispense", dot: "var(--badge-warn-fg)" },
      { key: "members", label: "Members", path: "/members", dot: "var(--primary)" },
      { key: "products", label: "Products", path: "/products", dot: "var(--tenant-accent-2)" },
      { key: "inventory", label: "Inventory", path: "/inventory", dot: "var(--tenant-accent-3)" },
    ],
  },
  {
    label: "Accounting",
    items: [
      { key: "donations", label: "Donations", path: "/donations", dot: "var(--tenant-accent-5)" },
      { key: "till", label: "Till & shifts", path: "/till", dot: "var(--tenant-accent-4)" },
    ],
  },
  {
    label: "Settings",
    items: [
      {
        key: "contract",
        label: "Contract template",
        path: "/settings/contract",
        dot: "var(--text-muted-2)",
      },
    ],
  },
] as const;

export function Sidebar({
  clubs,
  userEmail,
}: {
  clubs: ClubMembershipSummary[];
  userEmail: string;
}) {
  const club = useClub();
  const pathname = usePathname();
  const [switcherOpen, setSwitcherOpen] = useState(false);

  return (
    <aside className="flex h-full w-[248px] flex-none flex-col bg-sidebar-bg text-sidebar-text">
      <div className="px-[18px] pb-3.5 pt-5">
        <div className="mb-4 flex items-center gap-2.5">
          <div className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-primary font-heading text-base font-bold text-white">
            G
          </div>
          <div className="font-heading text-[19px] font-bold tracking-[-0.02em] text-white">
            GaafD
          </div>
          <div className="ml-auto rounded-[5px] border border-sidebar-border-dark px-1.5 py-0.5 font-mono text-[10px] text-[#7f877a]">
            SaaS
          </div>
        </div>

        <div className="relative">
          <button
            type="button"
            onClick={() => setSwitcherOpen((open) => !open)}
            className="flex w-full items-center gap-2.5 rounded-[10px] border border-sidebar-border-dark bg-sidebar-surface px-[11px] py-[9px] text-left hover:bg-[#252c22]"
          >
            <div
              className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[7px] font-heading text-xs font-bold text-white"
              style={{ background: club.accentColor }}
            >
              {club.initials}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-semibold text-white">{club.name}</div>
            </div>
            <div className="text-[11px] text-[#8a9182]">▾</div>
          </button>

          {switcherOpen && (
            <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-40 rounded-[10px] border border-sidebar-border-dark bg-sidebar-surface p-1.5 shadow-[0_12px_30px_rgba(0,0,0,.4)]">
              {clubs.map((c) => (
                <Link
                  key={c.clubId}
                  href={`/${c.slug}`}
                  onClick={() => setSwitcherOpen(false)}
                  className="flex w-full items-center gap-2.5 rounded-[7px] px-[9px] py-2 text-left hover:bg-[#2a3126]"
                >
                  <div
                    className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-[6px] font-heading text-[10px] font-bold text-white"
                    style={{ background: c.accentColor }}
                  >
                    {c.initials}
                  </div>
                  <div className="min-w-0 flex-1 truncate text-xs font-medium text-[#e9ede6]">
                    {c.name}
                  </div>
                  {c.slug === club.slug && (
                    <span className="text-xs text-sidebar-accent-dot">●</span>
                  )}
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-1.5">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="px-2.5 pb-1.5 pt-2.5 text-[10px] uppercase tracking-[.09em] text-sidebar-text-muted">
              {group.label}
            </div>
            {group.items.map((item) => {
              const href = `/${club.slug}${item.path}`;
              const active = item.path === "" ? pathname === href : pathname.startsWith(href);
              return (
                <Link
                  key={item.key}
                  href={href}
                  className="my-px flex items-center gap-2.5 rounded-r-lg border-l-2 px-[11px] py-[9px] text-[13px]"
                  style={{
                    background: active ? "var(--sidebar-surface)" : "transparent",
                    borderLeftColor: active ? "var(--sidebar-accent-dot)" : "transparent",
                    color: active ? "#eef1ea" : "#a8afa1",
                  }}
                >
                  <span className="h-1.5 w-1.5 flex-none rounded-sm" style={{ background: item.dot }} />
                  <span className="flex-1">{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="flex items-center gap-2.5 border-t border-[#262c22] p-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-white">
          {club.role === "admin" ? "AD" : "ST"}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-semibold text-[#eef1ea]">{userEmail}</div>
          <div className="text-[10.5px] text-[#8a9182]">
            {club.role === "admin" ? "Admin" : "Staff"}
          </div>
        </div>
        <form action={signOut}>
          <button type="submit" title="Sign out" className="text-sm text-[#8a9182] hover:text-[#e9ede6]">
            ⏻
          </button>
        </form>
      </div>
    </aside>
  );
}
