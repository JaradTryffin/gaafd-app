import { afterEach, describe, expect, it, vi } from "vitest";
import { formatRand, formatRelativeTime, sastDayRange, sastMonthStart } from "@/lib/format";

afterEach(() => {
  vi.useRealTimers();
});

describe("formatRand", () => {
  it("formats a whole number with comma grouping and an R prefix", () => {
    expect(formatRand(6340)).toBe("R 6,340");
  });

  it("formats zero", () => {
    expect(formatRand(0)).toBe("R 0");
  });

  it("formats large amounts with multiple grouping separators", () => {
    expect(formatRand(1234567)).toBe("R 1,234,567");
  });

  it("rounds fractional rand to the nearest whole number", () => {
    expect(formatRand(150.5)).toBe("R 151");
  });
});

describe("formatRelativeTime", () => {
  it("returns 'just now' for under a minute", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T12:00:30.000Z"));
    expect(formatRelativeTime("2026-07-25T12:00:00.000Z")).toBe("just now");
  });

  it("returns minutes for under an hour", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T12:02:00.000Z"));
    expect(formatRelativeTime("2026-07-25T12:00:00.000Z")).toBe("2m");
  });

  it("returns 59m just under the hour boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T12:59:00.000Z"));
    expect(formatRelativeTime("2026-07-25T12:00:00.000Z")).toBe("59m");
  });

  it("returns hours at and after the hour boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T13:00:00.000Z"));
    expect(formatRelativeTime("2026-07-25T12:00:00.000Z")).toBe("1h");
  });

  it("returns days after the 24h boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T13:00:01.000Z"));
    expect(formatRelativeTime("2026-07-25T12:00:00.000Z")).toBe("1d");
  });
});

describe("sastDayRange", () => {
  it("keeps a timestamp just before SAST midnight in the same SAST day", () => {
    // 21:59:59Z = 23:59:59 SAST (UTC+2) -> still 25 July SAST.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T21:59:59.000Z"));
    const today = sastDayRange(0);
    expect(today.start).toBe("2026-07-24T22:00:00.000Z");
    expect(today.end).toBe("2026-07-25T22:00:00.000Z");
  });

  it("rolls over to the next SAST day exactly at the boundary", () => {
    // 22:00:00Z = 00:00:00 SAST the next day -> 26 July SAST.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T22:00:00.000Z"));
    const today = sastDayRange(0);
    expect(today.start).toBe("2026-07-25T22:00:00.000Z");
    expect(today.end).toBe("2026-07-26T22:00:00.000Z");
  });

  it("yesterday's range ends exactly where today's range starts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T21:59:59.000Z"));
    expect(sastDayRange(1).end).toBe(sastDayRange(0).start);
  });
});

describe("sastMonthStart", () => {
  it("stays in the previous month just before the SAST month boundary", () => {
    // 21:59:00Z = 23:59 SAST on 31 July -> still July.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T21:59:00.000Z"));
    expect(sastMonthStart()).toBe("2026-06-30T22:00:00.000Z");
  });

  it("rolls to the new month exactly at the SAST boundary", () => {
    // 22:00:00Z on 31 July = 00:00 SAST on 1 August.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T22:00:00.000Z"));
    expect(sastMonthStart()).toBe("2026-07-31T22:00:00.000Z");
  });
});
