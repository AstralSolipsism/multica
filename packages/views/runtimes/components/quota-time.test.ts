// @vitest-environment node

import { describe, expect, it } from "vitest";
import { formatQuotaTime } from "./quota-time";

// 2026-10-10 17:06:52 in Asia/Shanghai.
const RESET_SEC = Date.UTC(2026, 9, 10, 9, 6, 52) / 1000;

describe("formatQuotaTime", () => {
  it("shows only the time on the viewer's current day", () => {
    const now = Date.UTC(2026, 9, 10, 2, 0);
    expect(formatQuotaTime(RESET_SEC, now, "Asia/Shanghai", "zh-Hans")).toBe("17:06");
  });

  it("adds the month and day on other days", () => {
    const now = Date.UTC(2026, 9, 7, 2, 0);
    expect(formatQuotaTime(RESET_SEC, now, "Asia/Shanghai", "zh-Hans")).toBe("10月10日 17:06");
    expect(formatQuotaTime(RESET_SEC, now, "Asia/Shanghai", "ja")).toBe("10月10日 17:06");
  });

  it("reads the clock and the calendar day in the viewer's timezone", () => {
    // 16:30 UTC is already 00:30 the next day in Shanghai.
    const at = Date.UTC(2026, 9, 10, 16, 30) / 1000;
    const now = Date.UTC(2026, 9, 10, 10, 0);
    expect(formatQuotaTime(at, now, "UTC", "zh-Hans")).toBe("16:30");
    expect(formatQuotaTime(at, now, "Asia/Shanghai", "zh-Hans")).toBe("10月11日 00:30");
  });

  it("follows the UI language", () => {
    const now = Date.UTC(2026, 9, 7, 2, 0);
    expect(formatQuotaTime(RESET_SEC, now, "Asia/Shanghai", "en")).toMatch(/^Oct 10, 05:06\sPM$/);
  });

  it("degrades to local time for a zone the runtime does not know", () => {
    expect(() =>
      formatQuotaTime(RESET_SEC, Date.UTC(2026, 9, 7), "Mars/Olympus_Mons", "en"),
    ).not.toThrow();
  });

  it("gives no text for a time past the Date range", () => {
    // Finite, so the wire schemas accept it, but no Date can hold it.
    expect(formatQuotaTime(9_000_000_000_000, Date.UTC(2026, 9, 7), "Asia/Shanghai", "en")).toBeNull();
  });
});
