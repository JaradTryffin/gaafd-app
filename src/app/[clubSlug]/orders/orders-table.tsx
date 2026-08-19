"use client";

import { useMemo, useState } from "react";
import { formatRelativeTime } from "@/lib/format";
import type { DispenseOrderHistoryRow } from "@/lib/dispense-orders";

const FILTERS = ["All", "Gifts only"] as const;
type Filter = (typeof FILTERS)[number];

export function OrdersTable({ orders }: { orders: DispenseOrderHistoryRow[] }) {
  const [filter, setFilter] = useState<Filter>("All");

  const filtered = useMemo(() => {
    return filter === "Gifts only" ? orders.filter((o) => o.hasGift) : orders;
  }, [orders, filter]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-[7px]">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className="rounded-[8px] border px-3 py-[7px] text-[12.5px] font-medium"
            style={
              filter === f
                ? { background: "var(--primary)", borderColor: "var(--primary)", color: "#fff" }
                : { background: "var(--card)", borderColor: "var(--border)", color: "#4a4e45" }
            }
          >
            {f}
          </button>
        ))}
      </div>

      <div className="rounded-card border border-border bg-card">
        {orders.length === 0 ? (
          <div className="px-6 py-16 text-center text-[13.5px] text-[#6b6f66]">No orders yet.</div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-16 text-center text-[13.5px] text-[#6b6f66]">No orders match this filter.</div>
        ) : (
          <>
            <div className="grid grid-cols-[140px_1fr_2fr_90px_100px] gap-3 border-b border-border bg-muted px-[18px] py-3 text-[11px] font-semibold uppercase tracking-[.05em] text-[#8a8e83]">
              <div>Staff</div>
              <div>Member</div>
              <div>Items</div>
              <div>Total</div>
              <div>When</div>
            </div>
            {filtered.map((o) => (
              <div
                key={o.id}
                className="grid grid-cols-[140px_1fr_2fr_90px_100px] items-center gap-3 border-b border-[#f4f2ea] px-[18px] py-3 last:border-b-0"
              >
                <div className="truncate text-[12px] text-[#6b6f66]">{o.staffEmail ?? "—"}</div>
                <div className="truncate text-[13px] font-medium">{o.memberName}</div>
                <div className="truncate text-[12px] text-[#6b6f66]">
                  {o.items.map((i, idx) => (
                    <span key={i.productId}>
                      {idx > 0 ? ", " : ""}
                      {i.isGift ? "🎁 " : ""}
                      {i.productName} ×{i.qty}
                    </span>
                  ))}
                </div>
                <div className="font-mono text-[13px] font-semibold text-primary">{o.tokenTotal}</div>
                <div className="text-[11px] text-[#9a9e93]">{formatRelativeTime(o.createdAt)}</div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
