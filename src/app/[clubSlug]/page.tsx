import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import {
  getDashboardKpis,
  getDispensingByCategory,
  getDonationsTrend,
  getLowStockAlerts,
  getRecentActivity,
  getTokensDispensedLast7Days,
  type ActivityItem,
  type CategoryShare,
  type DonationsTrendPoint,
  type LowStockAlert,
  type TokenDispenseDay,
} from "@/lib/dashboard";
import { formatRand, formatRelativeTime } from "@/lib/format";
import { DashboardHeader } from "./dashboard-header";

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const supabase = await createClient();
  const access = await resolveClubAccess(supabase, clubSlug);
  if (!access) notFound();
  if (access.role !== "admin") redirect(`/${clubSlug}/dispense`);

  const [kpis, lowStockAlerts, activity, tokensLast7Days, donationsTrend, dispensingByCategory] =
    await Promise.all([
      getDashboardKpis(supabase, access.clubId),
      getLowStockAlerts(supabase, access.clubId, 5),
      getRecentActivity(supabase, access.clubId, 8),
      getTokensDispensedLast7Days(supabase, access.clubId),
      getDonationsTrend(supabase, access.clubId),
      getDispensingByCategory(supabase, access.clubId),
    ]);

  return (
    <>
      <DashboardHeader clubName={access.name} />
      <div>
        <div className="grid grid-cols-4 gap-3.5">
          <KpiCard
            label="Active members"
            dotColor="#8ba6ff"
            value={String(kpis.activeMembers)}
            delta={`${kpis.newMembersThisMonth} new this month`}
            deltaColor="#6b6f66"
          />
          <KpiCard
            label="Donations today"
            dotColor="#6fbf82"
            value={formatRand(kpis.donationsTodayRand)}
            delta={kpis.donationsDelta?.text}
            deltaColor={
              kpis.donationsDelta
                ? kpis.donationsDelta.positive
                  ? "#3f7a4e"
                  : "#b4432f"
                : undefined
            }
          />
          <KpiCard
            label="Low-stock items"
            dotColor="#c98f6a"
            value={String(kpis.lowStockCount)}
            delta={kpis.lowStockCount > 0 ? "needs reorder" : "all stocked"}
            deltaColor={kpis.lowStockCount > 0 ? "#b4432f" : "#6b6f66"}
          />
          <KpiCard
            label="Tokens dispensed today"
            dotColor="#e0996a"
            value={String(kpis.tokensDispensedToday)}
          />
        </div>

        <div className="mt-4 grid grid-cols-[1.6fr_1fr] gap-4">
          <div className="rounded-card border border-border bg-card p-[18px]">
            <div className="mb-3.5 font-heading text-[15px] font-semibold">
              Tokens dispensed · last 7 days
            </div>
            {tokensLast7Days.every((d) => d.tokens === 0) ? (
              <div className="flex h-[180px] items-center justify-center px-4 text-center text-[12.5px] text-[#9a9e93]">
                No dispensing activity in the last 7 days.
              </div>
            ) : (
              <TokensChart days={tokensLast7Days} />
            )}
          </div>

          <div className="rounded-card border border-border bg-card p-[18px]">
            <div className="mb-3 font-heading text-[15px] font-semibold">Low stock alerts</div>
            {lowStockAlerts.length === 0 ? (
              <div className="flex h-[120px] items-center justify-center text-center text-[12.5px] text-[#9a9e93]">
                Nothing low on stock.
              </div>
            ) : (
              lowStockAlerts.map((alert) => <LowStockRow key={alert.productId} alert={alert} />)
            )}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-[1.4fr_1fr] gap-4">
          <div className="rounded-card border border-border bg-card p-[18px]">
            <div className="mb-3 flex items-center">
              <div className="font-heading text-[15px] font-semibold">Donations trend</div>
              <div className="ml-auto font-mono text-[11.5px] text-[#6b6f66]">monthly · ZAR</div>
            </div>
            {donationsTrend.every((p) => p.totalRand === 0) ? (
              <div className="flex h-[160px] items-center justify-center px-4 text-center text-[12.5px] text-[#9a9e93]">
                No donations in the last 6 months.
              </div>
            ) : (
              <DonationsTrendChart points={donationsTrend} />
            )}
          </div>

          <div className="rounded-card border border-border bg-card p-[18px]">
            <div className="mb-4 font-heading text-[15px] font-semibold">Dispensing by category</div>
            {dispensingByCategory.length === 0 ? (
              <div className="flex h-[120px] items-center justify-center text-center text-[12.5px] text-[#9a9e93]">
                Nothing dispensed in the last 30 days.
              </div>
            ) : (
              <DispensingByCategoryDonut categories={dispensingByCategory} />
            )}
          </div>
        </div>

        <div className="mt-4 rounded-card border border-border bg-card p-[18px]">
          <div className="mb-1.5 font-heading text-[15px] font-semibold">Recent activity</div>
          {activity.length === 0 ? (
            <div className="flex h-[100px] items-center justify-center text-center text-[12.5px] text-[#9a9e93]">
              No activity yet.
            </div>
          ) : (
            activity.map((item) => <ActivityRow key={`${item.kind}-${item.id}`} item={item} />)
          )}
        </div>
      </div>
    </>
  );
}

function KpiCard({
  label,
  dotColor,
  value,
  delta,
  deltaColor,
}: {
  label: string;
  dotColor: string;
  value: string;
  delta?: string;
  deltaColor?: string;
}) {
  return (
    <div className="rounded-card border border-border bg-card p-4">
      <div className="flex items-center gap-[7px] text-xs text-[#6b6f66]">
        <span className="h-[7px] w-[7px] rounded-[2px]" style={{ background: dotColor }} />
        {label}
      </div>
      <div className="mt-[9px] font-mono text-[26px] font-semibold tracking-[-0.02em]">
        {value}
      </div>
      {delta && (
        <div className="mt-[3px] text-[11.5px]" style={{ color: deltaColor }}>
          {delta}
        </div>
      )}
    </div>
  );
}

function TokensChart({ days }: { days: TokenDispenseDay[] }) {
  const max = Math.max(1, ...days.map((d) => d.tokens));
  return (
    <div className="flex h-[180px] items-end gap-2.5 px-1">
      {days.map((d, i) => (
        <div key={`${d.label}-${i}`} className="flex flex-1 flex-col items-center gap-1.5">
          <div className="font-mono text-[11px] text-[#9a9e93]">{d.tokens > 0 ? d.tokens : ""}</div>
          <div
            className="w-full rounded-t-[4px]"
            style={{ height: `${Math.max(4, (d.tokens / max) * 110)}px`, background: "#e0996a" }}
          />
          <div className="text-[10.5px] text-[#9a9e93]">{d.label}</div>
        </div>
      ))}
    </div>
  );
}

const DONUT_PALETTE = ["#3f7a4e", "#8a6d3b", "#4a6b8a", "#7a4a6b", "#6b7a4a"];

function DonationsTrendChart({ points }: { points: DonationsTrendPoint[] }) {
  const width = 600;
  const yTop = 15;
  const yBottom = 170;
  const max = Math.max(1, ...points.map((p) => p.totalRand));
  const step = points.length > 1 ? width / (points.length - 1) : 0;
  const coords = points.map((p, i) => ({
    x: i * step,
    y: yBottom - (p.totalRand / max) * (yBottom - yTop),
  }));
  const linePath = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x},${c.y}`).join(" ");
  const lastX = coords[coords.length - 1]?.x ?? 0;
  const firstX = coords[0]?.x ?? 0;
  const areaPath = `${linePath} L${lastX},${yBottom} L${firstX},${yBottom} Z`;

  return (
    <>
      <div className="relative h-[160px] w-full">
        <svg
          viewBox="0 0 600 190"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
        >
          <path d={areaPath} fill="rgba(47,93,58,.10)" />
          <path
            d={linePath}
            fill="none"
            stroke="#2f5d3a"
            strokeWidth={2.5}
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
        {coords.map((c, i) => (
          <div
            key={i}
            className="absolute rounded-full border-[2.5px] border-[#2f5d3a] bg-white"
            style={{
              left: `${(c.x / width) * 100}%`,
              top: `${(c.y / 190) * 100}%`,
              width: 9,
              height: 9,
              margin: "-4.5px 0 0 -4.5px",
            }}
          />
        ))}
      </div>
      <div className="mt-2 flex">
        {points.map((p, i) => (
          <div key={i} className="flex-1 text-center text-[11px] text-[#8a8e83]">
            {p.label}
          </div>
        ))}
      </div>
    </>
  );
}

function DispensingByCategoryDonut({ categories }: { categories: CategoryShare[] }) {
  let cursor = 0;
  const stops = categories.map((c, i) => {
    const color = DONUT_PALETTE[i % DONUT_PALETTE.length];
    const start = cursor;
    cursor += c.pct;
    return `${color} ${start}% ${cursor}%`;
  });
  const gradient = `conic-gradient(${stops.join(", ")})`;

  return (
    <div className="flex items-center gap-4">
      <div className="relative h-[120px] w-[120px] flex-none rounded-full" style={{ background: gradient }}>
        <div className="absolute inset-6 rounded-full bg-card" />
      </div>
      <div className="flex flex-1 flex-col gap-2">
        {categories.map((c, i) => (
          <div key={c.label} className="flex items-center gap-2 text-[12px]">
            <span
              className="h-[9px] w-[9px] flex-none rounded-[2px]"
              style={{ background: DONUT_PALETTE[i % DONUT_PALETTE.length] }}
            />
            <span className="flex-1 text-[#4a4e45]">{c.label}</span>
            <span className="font-mono text-[#1c1e1a]">{Math.round(c.pct)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LowStockRow({ alert }: { alert: LowStockAlert }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-[#f0eee6] py-2.5 last:border-b-0">
      <div className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[8px] bg-accent font-mono text-[11px] text-[#3f7a4e]">
        {alert.category.slice(0, 3).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{alert.name}</div>
        <div className="text-[11px] text-[#8a8e83]">
          {alert.stock} {alert.unit.includes("g") ? "g" : "u"} left
        </div>
      </div>
      <div className="rounded-[6px] bg-[#f8e9e4] px-[7px] py-0.5 font-mono text-[11px] text-destructive">
        low
      </div>
    </div>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  return (
    <div className="flex items-center gap-3 border-b border-[#f0eee6] py-[11px] last:border-b-0">
      <div
        className="h-2 w-2 flex-none rounded-full"
        style={{ background: item.kind === "donation" ? "#6fbf82" : "#8ba6ff" }}
      />
      <div className="w-[76px] flex-none font-mono text-[11px] text-[#9a9e93]">
        {item.kind === "donation" ? "DONATION" : "MEMBER"}
      </div>
      <div className="flex-1 text-[13px]">
        {item.kind === "donation"
          ? `${item.memberName} donated (${item.method})`
          : `New member registered · ${item.code}`}
      </div>
      <div className="font-mono text-[12px] font-medium text-primary">
        {item.kind === "donation" ? `+${item.tokensCredited}` : ""}
      </div>
      <div className="w-[52px] flex-none text-right text-[11px] text-[#9a9e93]">
        {formatRelativeTime(item.timestamp)}
      </div>
    </div>
  );
}
