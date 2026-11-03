/**
 * HTTP entry points of the MCP servers. Authentication happens here and the
 * tenant context is fixed before any tool can run; tools never receive a
 * tenant id from the caller.
 */
import { createCustomerAgent } from "@/server/agents/customer";
import type { Services } from "@/server/container";
import {
  clientIp,
  mcpKeyLimiter,
  submissionLimiter,
  tooManyRequests,
  requestLang,
} from "@/server/http/rate-limit";
import type { LlmClient } from "@/server/llm";
import type { TenantContext } from "@/server/services/context";
import { createBusinessMcpServer } from "./business/server";
import { createCustomerMcpServer } from "./customer/server";
import { bearerToken, jsonRpcError, serveMcp, sessionCookie } from "./http";
import { createPublicMcpServer } from "./public/server";

type Resolved =
  { ok: true; ctx: TenantContext; apiKeyId?: string } | { ok: false; response: Response };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Customer MCP: the Customer Agent's key must belong to the store named by the slug. */
export async function resolveCustomerContext(
  request: Request,
  slug: string,
  tenancy: Services["tenancy"],
): Promise<Resolved> {
  const token = bearerToken(request);
  if (!token) return { ok: false, response: jsonRpcError(401, "Missing bearer token") };

  const fromKey = await tenancy.contextFromApiKey(token, "customer_agent", "customer_agent");
  if (!fromKey) return { ok: false, response: jsonRpcError(401, "Invalid API key") };

  const fromSlug = await tenancy.contextFromSlug(slug, "customer_agent");
  if (!fromSlug) return { ok: false, response: jsonRpcError(404, "Store not found") };

  if (fromKey.tenantId !== fromSlug.tenantId) {
    return { ok: false, response: jsonRpcError(403, "This key does not belong to this store") };
  }
  return { ok: true, ctx: fromSlug, apiKeyId: fromKey.apiKeyId };
}

/**
 * Business MCP: an owner session acts as the owner; an owner API key is the
 * Business Agent's credential and acts as the agent, so owner-only operations
 * (confirming the model, approving change sets) stay with the owner.
 */
export async function resolveBusinessContext(
  request: Request,
  tenancy: Services["tenancy"],
): Promise<Resolved> {
  const session = sessionCookie(request);
  if (session) {
    const ctx = await tenancy.contextFromSession(session);
    if (ctx?.role === "staff") {
      return { ok: false, response: jsonRpcError(403, "Only the business owner can do this") };
    }
    if (ctx) return { ok: true, ctx };
  }
  const token = bearerToken(request);
  if (token) {
    const ctx = await tenancy.contextFromApiKey(token, "owner", "business_agent");
    if (ctx) return { ok: true, ctx };
    return { ok: false, response: jsonRpcError(401, "Invalid API key") };
  }
  return { ok: false, response: jsonRpcError(401, "Sign in or provide an owner API key") };
}

/** 429 when the API key exceeded its per-minute allowance; sessions and keyless calls pass. */
async function limitKey(request: Request, apiKeyId: string | undefined): Promise<Response | null> {
  if (!apiKeyId) return null;
  const result = await mcpKeyLimiter.check(apiKeyId);
  return result.ok ? null : tooManyRequests(result.retryAfterSeconds, requestLang(request));
}

export async function handleCustomerMcp(
  request: Request,
  slug: string,
  services: Services,
): Promise<Response> {
  const resolved = await resolveCustomerContext(request, slug, services.tenancy);
  if (!resolved.ok) return resolved.response;
  const limited = await limitKey(request, resolved.apiKeyId);
  if (limited) return limited;

  const channel = request.headers.get("x-storefront-channel");
  const conversationId = request.headers.get("x-conversation-id") ?? undefined;
  if (conversationId !== undefined && !UUID.test(conversationId)) {
    return jsonRpcError(400, "Invalid conversation id");
  }

  const server = createCustomerMcpServer({
    ctx: resolved.ctx,
    services,
    source: channel === "external_agent" ? "external_agent" : "storefront",
    conversationId,
    webhooks: services.webhooks,
    guards: resolved.apiKeyId
      ? { allowSubmission: () => submissionLimiter.check(`key:${resolved.apiKeyId}`) }
      : undefined,
  });
  return serveMcp(request, server);
}

/** Public endpoint for external AI agents: no credentials, the store comes from the slug. */
export async function handlePublicMcp(
  request: Request,
  slug: string,
  services: Services,
  llm: LlmClient | null,
): Promise<Response> {
  const ctx = await services.tenancy.contextFromSlug(slug, "customer_agent");
  if (!ctx) return jsonRpcError(404, "Store not found");
  const tenant = await services.tenancy.getTenant(ctx);
  const server = createPublicMcpServer({
    ctx,
    storeName: tenant.name,
    agent: createCustomerAgent({ services, llm }),
    clientKey: `${clientIp(request)}:${slug}`,
  });
  return serveMcp(request, server);
}

export async function handleBusinessMcp(request: Request, services: Services): Promise<Response> {
  const resolved = await resolveBusinessContext(request, services.tenancy);
  if (!resolved.ok) return resolved.response;
  const limited = await limitKey(request, resolved.ctx.apiKeyId);
  if (limited) return limited;
  return serveMcp(request, createBusinessMcpServer({ ctx: resolved.ctx, services }));
}
