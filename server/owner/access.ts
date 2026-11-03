import { redirect } from "next/navigation";
import type { TenantContext } from "@/server/services/context";

export const STAFF_HOME = "/app/inbox";

/** Sends staff to their home page; call at the top of owner-only pages and actions. */
export function ownerOnly(ctx: TenantContext): void {
  if (ctx.role === "staff") redirect(STAFF_HOME);
}
