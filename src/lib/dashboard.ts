import type { SupabaseClient } from "@supabase/supabase-js";
import { sastDayRange, sastMonthStart } from "@/lib/format";

export const LOW_STOCK_THRESHOLD = 8;

export type DashboardKpis = {
  activeMembers: number;
  newMembersThisMonth: number;
  donationsTodayRand: number;
  donationsDelta: { text: string; positive: boolean } | null;
  lowStockCount: number;
};

function computeDonationsDelta(
  today: number,
  yesterday: number,
): { text: string; positive: boolean } | null {
  if (yesterday === 0) {
    return today > 0 ? { text: "New today", positive: true } : null;
  }
  const diff = today - yesterday;
  const pct = Math.round((Math.abs(diff) / yesterday) * 100);
  const positive = diff >= 0;
  const arrow = positive ? "▲" : "▼";
  return { text: `${arrow} ${pct}% vs yesterday`, positive };
}

export async function getDashboardKpis(
  supabase: SupabaseClient,
  clubId: string,
): Promise<DashboardKpis> {
  const { count: activeMembers, error: activeError } = await supabase
    .from("members")
    .select("id", { count: "exact", head: true })
    .eq("club_id", clubId)
    .eq("status", "active");
  if (activeError) throw activeError;

  const { count: newMembersThisMonth, error: newMembersError } = await supabase
    .from("members")
    .select("id", { count: "exact", head: true })
    .eq("club_id", clubId)
    .gte("joined_at", sastMonthStart());
  if (newMembersError) throw newMembersError;

  const today = sastDayRange(0);
  const { data: todayDonations, error: todayError } = await supabase
    .from("donations")
    .select("amount_rand")
    .eq("club_id", clubId)
    .gte("created_at", today.start)
    .lt("created_at", today.end);
  if (todayError) throw todayError;
  const donationsTodayRand = (todayDonations ?? []).reduce(
    (sum, d) => sum + Number(d.amount_rand),
    0,
  );

  const yesterday = sastDayRange(1);
  const { data: yesterdayDonations, error: yesterdayError } = await supabase
    .from("donations")
    .select("amount_rand")
    .eq("club_id", clubId)
    .gte("created_at", yesterday.start)
    .lt("created_at", yesterday.end);
  if (yesterdayError) throw yesterdayError;
  const donationsYesterdayRand = (yesterdayDonations ?? []).reduce(
    (sum, d) => sum + Number(d.amount_rand),
    0,
  );

  const { data: products, error: productsError } = await supabase
    .from("products")
    .select("id")
    .eq("club_id", clubId)
    .eq("active", true);
  if (productsError) throw productsError;
  const productIds = (products ?? []).map((p) => p.id);

  let lowStockCount = 0;
  if (productIds.length > 0) {
    const { data: stockRows, error: stockError } = await supabase
      .from("product_stock")
      .select("stock")
      .eq("club_id", clubId)
      .in("product_id", productIds)
      .lte("stock", LOW_STOCK_THRESHOLD);
    if (stockError) throw stockError;
    lowStockCount = (stockRows ?? []).length;
  }

  return {
    activeMembers: activeMembers ?? 0,
    newMembersThisMonth: newMembersThisMonth ?? 0,
    donationsTodayRand,
    donationsDelta: computeDonationsDelta(donationsTodayRand, donationsYesterdayRand),
    lowStockCount,
  };
}

export type LowStockAlert = {
  productId: string;
  name: string;
  category: string;
  unit: string;
  stock: number;
};

export async function getLowStockAlerts(
  supabase: SupabaseClient,
  clubId: string,
  limit: number,
): Promise<LowStockAlert[]> {
  const { data: products, error: productsError } = await supabase
    .from("products")
    .select("id, name, category, unit")
    .eq("club_id", clubId)
    .eq("active", true);
  if (productsError) throw productsError;
  if (!products || products.length === 0) return [];

  const { data: stockRows, error: stockError } = await supabase
    .from("product_stock")
    .select("product_id, stock")
    .eq("club_id", clubId)
    .in(
      "product_id",
      products.map((p) => p.id),
    )
    .lte("stock", LOW_STOCK_THRESHOLD);
  if (stockError) throw stockError;

  const stockByProductId = new Map((stockRows ?? []).map((r) => [r.product_id as string, r.stock as number]));

  return products
    .filter((p) => stockByProductId.has(p.id))
    .map((p) => ({
      productId: p.id as string,
      name: p.name as string,
      category: p.category as string,
      unit: p.unit as string,
      stock: stockByProductId.get(p.id)!,
    }))
    .sort((a, b) => a.stock - b.stock)
    .slice(0, limit);
}

export type ActivityItem =
  | {
      kind: "donation";
      id: string;
      memberName: string;
      method: string;
      tokensCredited: number;
      timestamp: string;
    }
  | {
      kind: "member";
      id: string;
      memberName: string;
      code: string;
      timestamp: string;
    };

export async function getRecentActivity(
  supabase: SupabaseClient,
  clubId: string,
  limit: number,
): Promise<ActivityItem[]> {
  const { data: donationRows, error: donationError } = await supabase
    .from("donations")
    .select("id, member_id, method, tokens_credited, created_at")
    .eq("club_id", clubId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (donationError) throw donationError;

  const { data: recentMemberRows, error: memberError } = await supabase
    .from("members")
    .select("id, first, last, code, joined_at")
    .eq("club_id", clubId)
    .order("joined_at", { ascending: false })
    .limit(limit);
  if (memberError) throw memberError;

  const donorIds = [...new Set((donationRows ?? []).map((d) => d.member_id as string))];
  let donorNamesById = new Map<string, string>();
  if (donorIds.length > 0) {
    const { data: donors, error: donorsError } = await supabase
      .from("members")
      .select("id, first, last")
      .in("id", donorIds);
    if (donorsError) throw donorsError;
    donorNamesById = new Map((donors ?? []).map((m) => [m.id as string, `${m.first} ${m.last}`]));
  }

  const donationItems: ActivityItem[] = (donationRows ?? []).map((d) => ({
    kind: "donation",
    id: d.id as string,
    memberName: donorNamesById.get(d.member_id as string) ?? "A member",
    method: d.method as string,
    tokensCredited: d.tokens_credited as number,
    timestamp: d.created_at as string,
  }));

  const memberItems: ActivityItem[] = (recentMemberRows ?? []).map((m) => ({
    kind: "member",
    id: m.id as string,
    memberName: `${m.first} ${m.last}`,
    code: m.code as string,
    timestamp: m.joined_at as string,
  }));

  return [...donationItems, ...memberItems]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);
}
