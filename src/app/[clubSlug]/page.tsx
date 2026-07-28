import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveClubAccess } from "@/lib/auth/club-access";
import {
  getDashboardKpis,
  getLowStockAlerts,
  getRecentActivity,
  type ActivityItem,
  type LowStockAlert,
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

  const [kpis, lowStockAlerts, activity] = await Promise.all([
    getDashboardKpis(supabase, access.clubId),
    getLowStockAlerts(supabase, access.clubId, 5),
    getRecentActivity(supabase, access.clubId, 8),
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
            value="—"
            delta="Available once Dispensing ships"
            deltaColor="#8a8e83"
          />
        </div>

        <div className="mt-4 grid grid-cols-[1.6fr_1fr] gap-4">
          <div className="rounded-card border border-border bg-card p-[18px]">
            <div className="mb-3.5 font-heading text-[15px] font-semibold">
              Tokens dispensed · last 7 days
            </div>
            <div className="flex h-[180px] items-center justify-center px-4 text-center text-[12.5px] text-[#9a9e93]">
              No dispensing activity yet — this fills in once the Dispensing screen is live.
            </div>
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
