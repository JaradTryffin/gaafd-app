// South Africa is UTC+2 year-round (no DST) — a fixed offset is correct,
// not a simplification that will drift.
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

export function formatRand(amount: number): string {
  // en-US locale purely for comma grouping to match the design mock's
  // "R 6,340" — not a claim about South African number formatting.
  return `R ${Math.round(amount).toLocaleString("en-US")}`;
}

export function formatRelativeTime(timestamp: string): string {
  const diffMs = Date.now() - new Date(timestamp).getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d`;
}

export function sastDayRange(daysAgo: number): { start: string; end: string } {
  const shifted = new Date(Date.now() + SAST_OFFSET_MS);
  const sastYear = shifted.getUTCFullYear();
  const sastMonth = shifted.getUTCMonth();
  const sastDate = shifted.getUTCDate();
  // Date.UTC(..., sastDate - daysAgo) naively treats the SAST calendar date
  // as if it were UTC midnight, then subtracting the offset converts that
  // to the real UTC instant of SAST midnight. Date.UTC handles day/month
  // underflow (e.g. date 0) correctly on its own.
  const startMs = Date.UTC(sastYear, sastMonth, sastDate - daysAgo) - SAST_OFFSET_MS;
  const endMs = startMs + 24 * 60 * 60 * 1000;
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}

export function sastMonthStart(): string {
  const shifted = new Date(Date.now() + SAST_OFFSET_MS);
  const sastYear = shifted.getUTCFullYear();
  const sastMonth = shifted.getUTCMonth();
  const startMs = Date.UTC(sastYear, sastMonth, 1) - SAST_OFFSET_MS;
  return new Date(startMs).toISOString();
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function sastWeekdayLabel(daysAgo: number): string {
  const shifted = new Date(Date.now() + SAST_OFFSET_MS);
  const sastYear = shifted.getUTCFullYear();
  const sastMonth = shifted.getUTCMonth();
  const sastDate = shifted.getUTCDate();
  const dayMs = Date.UTC(sastYear, sastMonth, sastDate - daysAgo);
  return WEEKDAY_LABELS[new Date(dayMs).getUTCDay()];
}

export function sastMonthRange(monthsAgo: number): { start: string; end: string } {
  const shifted = new Date(Date.now() + SAST_OFFSET_MS);
  const sastYear = shifted.getUTCFullYear();
  const sastMonth = shifted.getUTCMonth();
  const startMs = Date.UTC(sastYear, sastMonth - monthsAgo, 1) - SAST_OFFSET_MS;
  const endMs = Date.UTC(sastYear, sastMonth - monthsAgo + 1, 1) - SAST_OFFSET_MS;
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function sastMonthLabel(monthsAgo: number): string {
  const shifted = new Date(Date.now() + SAST_OFFSET_MS);
  const sastYear = shifted.getUTCFullYear();
  const sastMonth = shifted.getUTCMonth();
  const d = new Date(Date.UTC(sastYear, sastMonth - monthsAgo, 1));
  return MONTH_LABELS[d.getUTCMonth()];
}
