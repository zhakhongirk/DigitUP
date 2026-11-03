import { negotiateLang, type Lang } from "@/server/storefront/i18n";

export const LANG_COOKIE = "lang";
export const LANG_MAX_AGE = 365 * 24 * 3600;

export function parseLang(value: string | null | undefined): Lang | null {
  return value === "en" || value === "ru" ? value : null;
}

/** The saved choice wins, then the browser's Accept-Language, then English. */
export function resolveLang(
  cookie: string | null | undefined,
  acceptLanguage: string | null | undefined,
): Lang {
  return parseLang(cookie) ?? negotiateLang(acceptLanguage);
}

export function cookieValue(header: string | null | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export function langFromRequest(request: Request): Lang {
  return resolveLang(
    cookieValue(request.headers.get("cookie"), LANG_COOKIE),
    request.headers.get("accept-language"),
  );
}
