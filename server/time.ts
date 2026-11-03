const DEFAULT_TIME_ZONE = "Asia/Almaty";

/** IANA zone used for every date shown to owners and buyers. */
export function appTimeZone(): string {
  const raw = process.env.APP_TIMEZONE?.trim();
  if (!raw) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en", { timeZone: raw });
    return raw;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/** "2 Nov 2026, 3:09 AM" in the app time zone. */
export function formatDateTime(at: Date, timeZone: string = appTimeZone()): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(at);
}

/** "30 Oct" in the app time zone. */
export function formatDay(at: Date, timeZone: string = appTimeZone()): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone }).format(at);
}
