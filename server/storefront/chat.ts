/**
 * Storefront chat over HTTP. The shopper's session is an opaque random id in
 * an http-only cookie; it maps to one conversation per store.
 */
import { randomBytes } from "node:crypto";
import { createCustomerAgent } from "@/server/agents/customer";
import type { AgentEvent } from "@/server/agents/runtime";
import type { Services } from "@/server/container";
import type { LlmClient } from "@/server/llm";
import { BodyTooLargeError, readBoundedJson } from "@/server/http/bounded-form";
import {
  clientIp,
  requestLang,
  submissionLimiter,
  tooManyRequests,
} from "@/server/http/rate-limit";
import { ServiceError } from "@/server/services/context";
import { z } from "zod";
import {
  draftDetailsSchema,
  missingOrderFields,
  orderItemInputSchema,
  type Order,
  type OrderItem,
} from "@/server/services/orders";
import { orderView } from "@/server/mcp/views";

export function storefrontOrderView(order: Order) {
  return {
    ...orderView(order),
    fulfillment: order.fulfillment,
    delivery_address: order.deliveryAddress,
    city: order.city,
    missing_fields: order.status === "draft" ? missingOrderFields(order) : [],
  };
}

export const CHAT_COOKIE = "sf_session";
const SESSION_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_MESSAGE_CHARS = 2000;
export const MAX_CHAT_BODY_BYTES = 16 * 1024;

export function readChatSession(request: Request): string | null {
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === CHAT_COOKIE && value && SESSION_PATTERN.test(value)) return value;
  }
  return null;
}

export function newChatSession(): string {
  return randomBytes(18).toString("base64url");
}

export function chatCookieHeader(session: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${CHAT_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`;
}

export type ChatStreamEvent =
  | AgentEvent
  | { type: "done"; conversationId: string; stoppedBy: string }
  | { type: "error"; message: string };

/**
 * Runs the Customer Agent (or the rule-based fallback when no model is configured) for one shopper message and streams events as
 * newline-delimited JSON.
 */
export async function handleChatMessage(
  request: Request,
  slug: string,
  services: Services,
  llm: LlmClient | null,
): Promise<Response> {
  const ctx = await services.tenancy.contextFromSlug(slug, "customer_agent");
  if (!ctx) return Response.json({ error: "store_not_found" }, { status: 404 });

  let body: unknown;
  try {
    body = await readBoundedJson(request, MAX_CHAT_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return Response.json({ error: "payload_too_large" }, { status: 413 });
    }
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const message = (body as { message?: unknown })?.message;
  if (typeof message !== "string" || message.trim() === "" || message.length > MAX_MESSAGE_CHARS) {
    return Response.json({ error: "invalid_message" }, { status: 400 });
  }

  const existing = readChatSession(request);
  const session = existing ?? newChatSession();
  const agent = createCustomerAgent({ services, llm });
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatStreamEvent) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        const result = await agent.reply({
          ctx,
          channel: "storefront",
          sessionKey: session,
          message: message.trim(),
          submissionKey: `${clientIp(request)}:${slug}`,
          onEvent: send,
        });
        send({ type: "done", conversationId: result.conversationId, stoppedBy: result.stoppedBy });
      } catch (error) {
        console.error("[chat] failed", error);
        send({ type: "error", message: "Something went wrong. Please try again." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      ...(existing ? {} : { "set-cookie": chatCookieHeader(session) }),
    },
  });
}

/** Visible chat history for the shopper's session: user and assistant text only. */
export async function handleChatHistory(
  request: Request,
  slug: string,
  services: Services,
  llm: LlmClient | null,
): Promise<Response> {
  const ctx = await services.tenancy.contextFromSlug(slug, "customer_agent");
  if (!ctx) return Response.json({ error: "store_not_found" }, { status: 404 });

  const available = true;
  const fallback = llm === null;
  const session = readChatSession(request);
  if (!session) return Response.json({ available, fallback, messages: [] });

  const [conversation] = await services.conversations.list(ctx, {
    agent: "customer",
    channel: "storefront",
    limit: 1,
    sessionKey: session,
  });
  if (!conversation) return Response.json({ available, fallback, messages: [] });

  const rows = await services.conversations.listMessages(ctx, conversation.id, { limit: 100 });
  return Response.json({
    available,
    fallback,
    messages: rows
      .filter((row) => (row.role === "user" || row.role === "assistant") && row.content)
      .map((row) => ({ role: row.role, content: row.content, createdAt: row.createdAt })),
  });
}

/**
 * The Confirm button under an order summary. Only the shopper whose
 * conversation created the draft can submit it.
 */
async function ownDraft(request: Request, slug: string, orderId: string, services: Services) {
  const ctx = await services.tenancy.contextFromSlug(slug, "customer_agent");
  if (!ctx) return null;
  const session = readChatSession(request);
  if (!session || !/^[0-9a-f-]{36}$/i.test(orderId)) return null;
  const [conversation] = await services.conversations.list(ctx, {
    agent: "customer",
    channel: "storefront",
    limit: 1,
    sessionKey: session,
  });
  const order = await services.orders.getOrder(ctx, orderId);
  if (!conversation || !order || order.conversationId !== conversation.id) return null;
  return { ctx, order };
}

/**
 * Changes the quantities or removes lines of the shopper's own draft from the
 * order card. Only lines already in the order can be kept.
 */
export async function handleOrderItems(
  request: Request,
  slug: string,
  orderId: string,
  services: Services,
): Promise<Response> {
  const found = await ownDraft(request, slug, orderId, services);
  if (!found) return Response.json({ error: "not_found" }, { status: 404 });
  const { ctx, order } = found;
  if (order.status !== "draft") {
    return Response.json({ error: "conflict", message: "Order is already sent." }, { status: 409 });
  }

  const body = ((await readBoundedJson(request, MAX_CHAT_BODY_BYTES).catch(() => null)) ?? {}) as {
    items?: unknown;
  };
  const parsed = z.array(orderItemInputSchema).min(1).max(50).safeParse(body.items);
  const current = order.items as OrderItem[];
  const allowed = parsed.success
    ? parsed.data.every((line) =>
        current.some(
          (item) => item.offerId === line.offerId && (item.size ?? "") === (line.size ?? ""),
        ),
      )
    : false;
  if (!parsed.success || !allowed) {
    return Response.json(
      { error: "invalid_items", message: "Check the items of your order." },
      { status: 400 },
    );
  }
  try {
    const updated = await services.orders.updateDraftItems(ctx, orderId, parsed.data);
    return Response.json(storefrontOrderView(updated));
  } catch (error) {
    if (error instanceof ServiceError) {
      return Response.json({ error: error.code, message: error.message }, { status: 409 });
    }
    throw error;
  }
}

export async function handleOrderConfirm(
  request: Request,
  slug: string,
  orderId: string,
  services: Services,
): Promise<Response> {
  const ctx = await services.tenancy.contextFromSlug(slug, "customer_agent");
  if (!ctx) return Response.json({ error: "store_not_found" }, { status: 404 });

  const session = readChatSession(request);
  if (!session || !/^[0-9a-f-]{36}$/i.test(orderId)) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const [conversation] = await services.conversations.list(ctx, {
    agent: "customer",
    channel: "storefront",
    limit: 1,
    sessionKey: session,
  });
  const order = await services.orders.getOrder(ctx, orderId);
  if (!conversation || !order || order.conversationId !== conversation.id) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const body = ((await readBoundedJson(request, MAX_CHAT_BODY_BYTES).catch(() => null)) ??
    {}) as Record<string, unknown>;
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() !== "" ? value : undefined;
  const parsed = draftDetailsSchema.safeParse({
    name: text(body.name),
    phone: text(body.phone),
    fulfillment: text(body.fulfillment),
    deliveryAddress: text(body.address),
    city: text(body.city),
  });
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_details", message: "Check your name, phone and delivery details." },
      { status: 400 },
    );
  }

  if (order.status === "draft") {
    const limit = await submissionLimiter.check(`${clientIp(request)}:${slug}`);
    if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds, requestLang(request));
  }

  try {
    if (order.status === "draft") {
      await services.orders.updateDraftDetails(ctx, orderId, parsed.data);
    }
    const submitted = await services.orders.submitOrder(ctx, orderId);
    return Response.json(storefrontOrderView(submitted));
  } catch (error) {
    if (error instanceof ServiceError) {
      return Response.json({ error: error.code, message: error.message }, { status: 409 });
    }
    throw error;
  }
}
