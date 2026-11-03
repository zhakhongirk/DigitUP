/**
 * Tenant context. Every tenant-scoped service call takes one. It is built on
 * the server from a session, an API key or a storefront slug (see the tenancy
 * service) and is never derived from LLM output or tool arguments.
 */
export type Actor = "owner" | "business_agent" | "customer_agent" | "system";

export interface TenantContext {
  readonly tenantId: string;
  readonly actor: Actor;
  /** Set when the call is made on behalf of a signed-in owner. */
  readonly userId?: string;
  /** Role of the signed-in user; unset for API key and storefront contexts. */
  readonly role?: "owner" | "staff";
}

export type ServiceErrorCode = "not_found" | "forbidden" | "unauthorized" | "invalid" | "conflict";

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;

  constructor(code: ServiceErrorCode, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

export function assertOwner(ctx: TenantContext): void {
  if (ctx.actor !== "owner") {
    throw new ServiceError("forbidden", "Only the business owner can do this");
  }
}

/** Rejects signed-in staff; owners and non-session contexts pass. */
export function assertNotStaff(ctx: TenantContext): void {
  if (ctx.role === "staff") {
    throw new ServiceError("forbidden", "Only the business owner can do this");
  }
}
