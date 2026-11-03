import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { changeSets, inquiries, kv, notifications, orders, tenants } from "@/db/schema";
import { orderNumber } from "@/server/storefront/order-status";
import { ServiceError, assertOwner, type TenantContext } from "../context";
import type { TelegramClient, TelegramUpdate } from "./client";

export * from "./client";

export const LINK_CODE_TTL_MS = 15 * 60 * 1000;
const OFFSET_KEY = "telegram.update_offset";
const POLL_TIMEOUT_SECONDS = 25;
const MAX_BACKOFF_MS = 60_000;

export interface TelegramStatus {
  configured: boolean;
  connected: boolean;
  link: { url: string; expiresAt: Date } | null;
}

export interface TelegramService {
  readonly configured: boolean;
  status(ctx: TenantContext): Promise<TelegramStatus>;
  issueLinkCode(ctx: TenantContext): Promise<{ code: string; url: string; expiresAt: Date }>;
  disconnect(ctx: TenantContext): Promise<void>;
  sendTest(ctx: TenantContext): Promise<void>;
  handleUpdates(updates: TelegramUpdate[]): Promise<void>;
  pollOnce(signal?: AbortSignal): Promise<number>;
  runPolling(signal: AbortSignal, onError?: (error: unknown) => void): Promise<void>;
  notifyOwner(input: { tenantId: string; kind: string; refId: string }): Promise<boolean>;
}

export interface TelegramDeps {
  db: Db;
  client: TelegramClient | null;
  botUsername: string | null;
  appUrl?: string;
  now?: () => Date;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

function money(total: number | null, currency: string | null): string {
  if (total === null) return "to be confirmed";
  return `${total.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${currency ?? ""}`.trim();
}

function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function createTelegramService(deps: TelegramDeps): TelegramService {
  const { db, client, botUsername } = deps;
  const now = deps.now ?? (() => new Date());
  const note = deps.log ?? (() => undefined);
  const sleep = deps.sleep ?? sleepUnlessAborted;
  const configured = client !== null && !!botUsername;
  const base = deps.appUrl?.replace(/\/+$/, "") ?? "";

  function requireClient(): TelegramClient {
    if (!client) throw new ServiceError("invalid", "Telegram notifications are not configured");
    return client;
  }

  async function chatOf(tenantId: string): Promise<string | null> {
    const [row] = await db
      .select({ chatId: tenants.telegramChatId })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    return row?.chatId ?? null;
  }

  async function consumeCode(code: string, chatId: string): Promise<string | null> {
    const [row] = await db
      .update(tenants)
      .set({ telegramChatId: chatId, telegramLinkCode: null, telegramLinkExpiresAt: null })
      .where(and(eq(tenants.telegramLinkCode, code), gt(tenants.telegramLinkExpiresAt, now())))
      .returning({ name: tenants.name });
    return row?.name ?? null;
  }

  async function handleUpdate(update: TelegramUpdate) {
    const message = update.message;
    const text = message?.text?.trim();
    if (!message || !text || message.chat.type === "channel") return;
    const match = /^\/start(?:@\w+)?\s+(\S+)$/.exec(text);
    const chatId = String(message.chat.id);
    const api = requireClient();
    if (!match?.[1]) {
      await api.sendMessage(
        chatId,
        "To link this chat, open Settings in your store dashboard, press Connect Telegram and follow the link.",
      );
      return;
    }
    const name = await consumeCode(match[1], chatId);
    await api.sendMessage(
      chatId,
      name
        ? `Connected. New orders, questions and approvals for ${name} will arrive here.`
        : "This link is invalid or has expired. Generate a new one in Settings.",
    );
  }

  async function describe(tenantId: string, kind: string, refId: string) {
    const link = (path: string) => (base ? `\n${base}${path}` : "");
    if (kind === "order") {
      const [order] = await db
        .select()
        .from(orders)
        .where(and(eq(orders.id, refId), eq(orders.tenantId, tenantId)));
      if (!order) return `New order\nOpen your inbox to review it.${link("/app/inbox")}`;
      const contact = (order.contact ?? {}) as { name?: string; phone?: string };
      const who = contact.name ?? contact.phone ?? "Customer";
      return `New order ${orderNumber(order.id)}\nFrom: ${oneLine(who, 80)}\nTotal: ${money(order.total, order.currency)}${link(`/app/inbox?item=order:${order.id}`)}`;
    }
    if (kind === "inquiry") {
      const [inquiry] = await db
        .select()
        .from(inquiries)
        .where(and(eq(inquiries.id, refId), eq(inquiries.tenantId, tenantId)));
      if (!inquiry) {
        return `New customer question\nOpen your inbox to answer it.${link("/app/inbox")}`;
      }
      const contact = (inquiry.contact ?? {}) as { name?: string; phone?: string };
      const who = contact.name ?? contact.phone;
      const head = who ? `New question from ${oneLine(who, 80)}` : "New customer question";
      return `${head}\n${oneLine(inquiry.subject, 200)}${link(`/app/inbox?item=inquiry:${inquiry.id}`)}`;
    }
    if (kind === "change_set") {
      const [changeSet] = await db
        .select({ ops: changeSets.ops })
        .from(changeSets)
        .where(and(eq(changeSets.id, refId), eq(changeSets.tenantId, tenantId)));
      const count = Array.isArray(changeSet?.ops) ? changeSet.ops.length : 0;
      const what = count === 1 ? "1 proposed change" : `${count} proposed changes`;
      return `An agent proposed changes to your store\n${count > 0 ? what : "Review them in Approvals."}${link(`/app/approvals?id=${refId}`)}`;
    }
    return null;
  }

  const service: TelegramService = {
    configured,

    async status(ctx) {
      assertOwner(ctx);
      const [row] = await db
        .select({
          chatId: tenants.telegramChatId,
          code: tenants.telegramLinkCode,
          expiresAt: tenants.telegramLinkExpiresAt,
        })
        .from(tenants)
        .where(eq(tenants.id, ctx.tenantId));
      const live = !!row?.code && !!row.expiresAt && row.expiresAt > now();
      return {
        configured,
        connected: !!row?.chatId,
        link:
          configured && live && row?.expiresAt
            ? { url: `https://t.me/${botUsername}?start=${row.code}`, expiresAt: row.expiresAt }
            : null,
      };
    },

    async issueLinkCode(ctx) {
      assertOwner(ctx);
      requireClient();
      const code = randomBytes(12).toString("base64url");
      const expiresAt = new Date(now().getTime() + LINK_CODE_TTL_MS);
      await db
        .update(tenants)
        .set({ telegramLinkCode: code, telegramLinkExpiresAt: expiresAt })
        .where(eq(tenants.id, ctx.tenantId));
      return { code, url: `https://t.me/${botUsername}?start=${code}`, expiresAt };
    },

    async disconnect(ctx) {
      assertOwner(ctx);
      await db
        .update(tenants)
        .set({ telegramChatId: null, telegramLinkCode: null, telegramLinkExpiresAt: null })
        .where(eq(tenants.id, ctx.tenantId));
    },

    async sendTest(ctx) {
      assertOwner(ctx);
      const api = requireClient();
      const chatId = await chatOf(ctx.tenantId);
      if (!chatId) throw new ServiceError("invalid", "Telegram is not connected");
      try {
        await api.sendMessage(chatId, "Test message. Notifications from your store are working.");
      } catch (error) {
        note("telegram.test_failed", { error });
        throw new ServiceError("invalid", "Telegram did not accept the message. Try again.");
      }
    },

    async handleUpdates(updates) {
      for (const update of updates) {
        try {
          await handleUpdate(update);
        } catch (error) {
          note("telegram.update_failed", { updateId: update.update_id, error });
        }
      }
    },

    async pollOnce(signal) {
      const api = requireClient();
      const [stored] = await db.select().from(kv).where(eq(kv.key, OFFSET_KEY));
      const offset = Number(stored?.value ?? 0) || 0;
      const updates = await api.getUpdates({
        offset,
        timeoutSeconds: POLL_TIMEOUT_SECONDS,
        signal,
      });
      if (updates.length === 0) return 0;
      await service.handleUpdates(updates);
      const next = Math.max(...updates.map((u) => u.update_id)) + 1;
      await db
        .insert(kv)
        .values({ key: OFFSET_KEY, value: String(next) })
        .onConflictDoUpdate({ target: kv.key, set: { value: String(next), updatedAt: now() } });
      return updates.length;
    },

    async runPolling(signal, onError) {
      if (!configured) return;
      let failures = 0;
      while (!signal.aborted) {
        try {
          await service.pollOnce(signal);
          failures = 0;
        } catch (error) {
          if (signal.aborted) break;
          failures += 1;
          onError?.(error);
          await sleep(Math.min(1000 * 2 ** failures, MAX_BACKOFF_MS), signal);
        }
      }
    },

    async notifyOwner({ tenantId, kind, refId }) {
      if (!client) return false;
      const chatId = await chatOf(tenantId);
      if (!chatId) return false;
      const [claimed] = await db
        .update(notifications)
        .set({ telegramSentAt: now() })
        .where(
          and(
            eq(notifications.tenantId, tenantId),
            eq(notifications.kind, kind),
            eq(notifications.refId, refId),
            isNull(notifications.telegramSentAt),
          ),
        )
        .returning({ id: notifications.id });
      if (!claimed) return false;
      try {
        const text = await describe(tenantId, kind, refId);
        if (!text) return false;
        await client.sendMessage(chatId, text);
        return true;
      } catch (error) {
        note("telegram.send_failed", { tenantId, kind, error });
        await db
          .update(notifications)
          .set({ telegramSentAt: null })
          .where(eq(notifications.id, claimed.id))
          .catch(() => undefined);
        return false;
      }
    },
  };
  return service;
}
