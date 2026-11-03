import { afterEach, describe, expect, it, vi } from "vitest";
import { formatWhen } from "@/server/owner/inbox";
import { appTimeZone, formatDateTime } from "@/server/time";

afterEach(() => vi.unstubAllEnvs());

describe("appTimeZone", () => {
  it("defaults to Asia/Almaty and honours APP_TIMEZONE", () => {
    vi.stubEnv("APP_TIMEZONE", "");
    expect(appTimeZone()).toBe("Asia/Almaty");
    vi.stubEnv("APP_TIMEZONE", "Europe/Berlin");
    expect(appTimeZone()).toBe("Europe/Berlin");
    vi.stubEnv("APP_TIMEZONE", "Not/AZone");
    expect(appTimeZone()).toBe("Asia/Almaty");
  });
});

describe("local time", () => {
  it("formats date and time in Almaty without a UTC suffix", () => {
    vi.stubEnv("APP_TIMEZONE", "Asia/Almaty");
    expect(formatDateTime(new Date("2026-11-02T20:30:00Z"))).toBe("Nov 3, 2026, 1:30 AM");
  });

  it("computes today and yesterday in the app zone", () => {
    vi.stubEnv("APP_TIMEZONE", "Asia/Almaty");
    const now = new Date("2026-11-02T20:30:00Z");
    expect(formatWhen(new Date("2026-11-02T19:10:00Z"), now)).toBe("00:10");
    expect(formatWhen(new Date("2026-11-02T18:00:00Z"), now)).toBe("Yesterday");
    expect(formatWhen(new Date("2026-11-02T20:00:00Z"), now, "UTC")).toBe("20:00");
  });
});
