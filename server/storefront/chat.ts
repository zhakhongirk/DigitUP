/**
 * Storefront chat over HTTP. The shopper's session is an opaque random id in
 * an http-only cookie; it maps to one conversation per store.
 */
import { randomBytes } from "node:crypto";
import { AgentUnavailableError, createCustomerAgent } from "@/server/agents/customer";
import type { AgentEvent } from "@/server/agents/runtime";
import type { Services } from "@/server/container";
import type { LlmClient } from "@/server/llm";
import { ServiceError } from "@/server/services/context";
import { orderView } from "@/server/mcp/views";

export const CHAT_COOKIE = "sf_session";
const SESSION_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_MESSAGE_CHARS = 2000;

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
 * Runs the Customer Agent for one shopper message and streams events as
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
  if (!llm) {
    return Response.json(
      { error: "assistant_unavailable", message: "The store assistant is not available yet." },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
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
          onEvent: send,
        });
        send({ type: "done", conversationId: result.conversationId, stoppedBy: result.stoppedBy });
      } catch (error) {
        if (!(error instanceof AgentUnavailableError)) console.error("[chat] failed", error);
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

  const available = llm !== null;
  const session = readChatSession(request);
  if (!session) return Response.json({ available, messages: [] });

  const [conversation] = await services.conversations.list(ctx, {
    agent: "customer",
    channel: "storefront",
    limit: 1,
    sessionKey: session,
  });
  if (!conversation) return Response.json({ available, messages: [] });

  const rows = await services.conversations.listMessages(ctx, conversation.id, { limit: 100 });
  return Response.json({
    available,
    messages: rows
      .filter((row) => (row.role === "user" || row.role === "assistant") && row.content)
      .map((row) => ({ role: row.role, content: row.content, createdAt: row.createdAt })),
  });
}

/**
 * The Confirm button under an order summary. Only the shopper whose
 * conversation created the draft can submit it.
 */
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

  try {
    const submitted = await services.orders.submitOrder(ctx, orderId);
    return Response.json(orderView(submitted));
  } catch (error) {
    if (error instanceof ServiceError) {
      return Response.json({ error: error.code, message: error.message }, { status: 409 });
    }
    throw error;
  }
}
