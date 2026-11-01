import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db/client";
import { conversations, messages } from "@/db/schema";
import type { EventPublisher } from "@/server/events/types";
import { EVENTS } from "@/server/events/types";
import { recordAudit } from "../audit";
import { ServiceError, type TenantContext } from "../context";

export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type ConversationAgent = Conversation["agent"];
export type ConversationChannel = Conversation["channel"];
export type ConversationStatus = Conversation["status"];

export interface NewMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** Stored in messages.tool_calls (jsonb), null when absent. */
  toolCalls?: unknown;
}

export interface ConversationsService {
  /**
   * With a sessionKey: returns the existing conversation for
   * (tenant, channel, sessionKey) or creates it. Without: always creates.
   */
  getOrCreate(
    ctx: TenantContext,
    input: { agent: ConversationAgent; channel: ConversationChannel; sessionKey?: string },
  ): Promise<Conversation>;
  get(ctx: TenantContext, conversationId: string): Promise<Conversation | null>;
  list(
    ctx: TenantContext,
    filter?: {
      agent?: ConversationAgent;
      channel?: ConversationChannel;
      status?: ConversationStatus;
      sessionKey?: string;
      limit?: number;
    },
  ): Promise<Conversation[]>;
  appendMessages(
    ctx: TenantContext,
    conversationId: string,
    messages: NewMessage[],
  ): Promise<Message[]>;
  /** The last `limit` messages, oldest first. */
  listMessages(
    ctx: TenantContext,
    conversationId: string,
    options?: { limit?: number },
  ): Promise<Message[]>;
  setStatus(
    ctx: TenantContext,
    conversationId: string,
    status: ConversationStatus,
  ): Promise<Conversation>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ServiceError("invalid", "limit must be a positive integer");
  }
  return Math.min(limit, MAX_LIMIT);
}

function notFound(): ServiceError {
  return new ServiceError("not_found", "Conversation not found");
}

export function createConversationsService(deps: {
  db: Db;
  events: EventPublisher;
}): ConversationsService {
  const { db, events } = deps;

  const requireOwned = async (ctx: TenantContext, conversationId: string) => {
    const [row] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, ctx.tenantId)));
    if (!row) throw notFound();
  };

  return {
    async getOrCreate(ctx, input) {
      const sessionKey = input.sessionKey;
      if (sessionKey !== undefined && sessionKey.trim() === "") {
        throw new ServiceError("invalid", "sessionKey must not be empty");
      }
      const values = {
        tenantId: ctx.tenantId,
        agent: input.agent,
        channel: input.channel,
        sessionKey: sessionKey ?? null,
      };

      return db.transaction(async (tx) => {
        const [created] = await tx
          .insert(conversations)
          .values(values)
          .onConflictDoNothing()
          .returning();
        if (created) {
          await recordAudit(tx, ctx, {
            action: "conversation.created",
            entity: "conversation",
            entityId: created.id,
            after: {
              agent: created.agent,
              channel: created.channel,
              sessionKey: sessionKey ?? null,
            },
          });
          return created;
        }
        if (sessionKey === undefined) {
          throw new ServiceError("conflict", "Could not create conversation");
        }
        const [existing] = await tx
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.tenantId, ctx.tenantId),
              eq(conversations.channel, input.channel),
              eq(conversations.sessionKey, sessionKey),
            ),
          );
        if (!existing) throw new ServiceError("conflict", "Could not resolve conversation");
        return existing;
      });
    },

    async get(ctx, conversationId) {
      const [row] = await db
        .select()
        .from(conversations)
        .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, ctx.tenantId)));
      return row ?? null;
    },

    async list(ctx, filter = {}) {
      const limit = clampLimit(filter.limit);
      const conditions: SQL[] = [eq(conversations.tenantId, ctx.tenantId)];
      if (filter.agent) conditions.push(eq(conversations.agent, filter.agent));
      if (filter.channel) conditions.push(eq(conversations.channel, filter.channel));
      if (filter.status) conditions.push(eq(conversations.status, filter.status));
      if (filter.sessionKey) conditions.push(eq(conversations.sessionKey, filter.sessionKey));
      return db
        .select()
        .from(conversations)
        .where(and(...conditions))
        .orderBy(desc(conversations.updatedAt), desc(conversations.createdAt))
        .limit(limit);
    },

    async appendMessages(ctx, conversationId, input) {
      if (input.length === 0) {
        await requireOwned(ctx, conversationId);
        return [];
      }
      return db.transaction(async (tx) => {
        const [locked] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(eq(conversations.id, conversationId), eq(conversations.tenantId, ctx.tenantId)),
          )
          .for("update");
        if (!locked) throw notFound();

        const [last] = await tx
          .select({ createdAt: messages.createdAt })
          .from(messages)
          .where(eq(messages.conversationId, conversationId))
          .orderBy(desc(messages.createdAt))
          .limit(1);
        const base = Math.max(Date.now(), last ? last.createdAt.getTime() + 1 : 0);

        const inserted = await tx
          .insert(messages)
          .values(
            input.map((m, i) => ({
              conversationId,
              role: m.role,
              content: m.content,
              toolCalls: m.toolCalls ?? null,
              createdAt: new Date(base + i),
            })),
          )
          .returning();
        inserted.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

        await tx
          .update(conversations)
          .set({ updatedAt: sql`now()` })
          .where(
            and(eq(conversations.id, conversationId), eq(conversations.tenantId, ctx.tenantId)),
          );

        for (const message of inserted) {
          if (message.role !== "user") continue;
          await events.publish(
            tx,
            EVENTS.conversationMessage,
            { tenantId: ctx.tenantId, conversationId, messageId: message.id },
            { singletonKey: message.id },
          );
        }
        return inserted;
      });
    },

    async listMessages(ctx, conversationId, options = {}) {
      const limit = clampLimit(options.limit);
      await requireOwned(ctx, conversationId);
      const rows = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(desc(messages.createdAt))
        .limit(limit);
      return rows.reverse();
    },

    async setStatus(ctx, conversationId, status) {
      return db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(conversations)
          .where(
            and(eq(conversations.id, conversationId), eq(conversations.tenantId, ctx.tenantId)),
          )
          .for("update");
        if (!before) throw notFound();
        const [after] = await tx
          .update(conversations)
          .set({ status, updatedAt: sql`now()` })
          .where(
            and(eq(conversations.id, conversationId), eq(conversations.tenantId, ctx.tenantId)),
          )
          .returning();
        if (!after) throw notFound();
        await recordAudit(tx, ctx, {
          action: "conversation.status_changed",
          entity: "conversation",
          entityId: conversationId,
          before: { status: before.status },
          after: { status: after.status },
        });
        return after;
      });
    },
  };
}
