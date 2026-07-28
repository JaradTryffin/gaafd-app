"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { MemberListRow } from "@/lib/members";

const STATUS_FILTERS = ["All", "Active", "Inactive"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

function initials(first: string, last: string): string {
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

export function MembersTable({
  clubSlug,
  members,
}: {
  clubSlug: string;
  members: MemberListRow[];
}) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return members
      .filter((m) => statusFilter === "All" || m.status === statusFilter.toLowerCase())
      .filter((m) => !q || `${m.first} ${m.last} ${m.code}`.toLowerCase().includes(q));
  }, [members, statusFilter, search]);

  return (
    <div>
      <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
        <div className="flex gap-[7px]">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setStatusFilter(f)}
              className="rounded-[8px] border px-3 py-[7px] text-[12.5px] font-medium"
              style={
                statusFilter === f
                  ? { background: "var(--primary)", borderColor: "var(--primary)", color: "#fff" }
                  : { background: "var(--card)", borderColor: "var(--border)", color: "#4a4e45" }
              }
            >
              {f}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search members…"
          aria-label="Search members"
          className="w-[220px] rounded-[9px] border border-input bg-card px-3 py-[7px] text-[13px]"
        />
        <Link
          href={`/${clubSlug}/members/register`}
          className="ml-auto rounded-[9px] px-[15px] py-[9px] text-[13px] font-semibold text-white"
          style={{ background: "var(--primary)" }}
        >
          + Register member
        </Link>
      </div>

      <div className="rounded-card border border-border bg-card">
        {members.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <div className="text-[13.5px] text-[#6b6f66]">
              No members yet — register your first member to get started.
            </div>
            <Link
              href={`/${clubSlug}/members/register`}
              className="rounded-[9px] px-5 py-2.5 text-[13px] font-semibold text-white"
              style={{ background: "var(--primary)" }}
            >
              + Register member
            </Link>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-16 text-center text-[13.5px] text-[#6b6f66]">
            No members match your filters.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[2fr_1fr_1fr_1fr_90px] gap-3 border-b border-border bg-muted px-[18px] py-3 text-[11px] font-semibold uppercase tracking-[.05em] text-[#8a8e83]">
              <div>Member</div>
              <div>Type</div>
              <div>Balance</div>
              <div>Referred by</div>
              <div>Status</div>
            </div>
            {filtered.map((m) => (
              <div
                key={m.id}
                className="grid grid-cols-[2fr_1fr_1fr_1fr_90px] items-center gap-3 border-b border-[#f4f2ea] px-[18px] py-[13px] last:border-b-0"
              >
                <div className="flex min-w-0 items-center gap-[11px]">
                  <div className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-full bg-accent text-xs font-semibold text-primary">
                    {initials(m.first, m.last)}
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-medium">
                      {m.first} {m.last}
                    </div>
                    <div className="font-mono text-[11px] text-[#9a9e93]">{m.code}</div>
                  </div>
                </div>
                <div className="text-[13px] text-[#4a4e45]">{m.type}</div>
                <div className="font-mono text-[13px] font-medium text-primary">
                  {m.tokenBalance}
                </div>
                <div className="text-[13px] text-[#6b6f66]">{m.referrerName ?? "—"}</div>
                <div>
                  <span
                    className={
                      m.status === "active"
                        ? "rounded-full bg-status-active-bg px-2.5 py-1 text-[11px] font-medium text-status-active-fg"
                        : "rounded-full bg-status-inactive-bg px-2.5 py-1 text-[11px] font-medium text-status-inactive-fg"
                    }
                  >
                    {m.status}
                  </span>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
