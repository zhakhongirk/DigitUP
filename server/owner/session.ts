import { cookies } from "next/headers";
import type { Services } from "@/server/container";
import { SESSION_COOKIE } from "@/server/mcp/http";
import type { TenantContext } from "@/server/services/context";

export const SESSION_MAX_AGE = 7 * 24 * 3600;

export function sessionCookieHeader(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}${secure}`;
}

/** Owner context of the signed-in user in server components and actions. */
export async function currentOwner(services: Services): Promise<TenantContext | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? services.tenancy.contextFromSession(token) : null;
}

export async function setSessionCookie(token: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_MAX_AGE,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
