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
