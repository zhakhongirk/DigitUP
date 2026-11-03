import { and, count, desc, eq, gte, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db/client";
import { conversations, inquiries, messages, orders } from "@/db/schema";
import type { EventPublisher } from "@/server/events/types";
import { EVENTS } from "@/server/events/types";
import { recordAudit } from "../audit";
import { assertOwner, ServiceError, type TenantContext } from "../context";

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

export interface ConversationStats {
  total: number;
  byChannel: Record<ConversationChannel, number>;
  /** Conversations that produced at least one non-draft order. */
  withOrder: number;
  withInquiry: number;
  /** Conversations that produced an order, an inquiry, or both. */
  withOutcome: number;
}

export interface DayCount {
  /** Calendar day in the requested time zone, YYYY-MM-DD. */
  day: string;
  count: number;
}

export interface FirstUserMessage {
  conversationId: string;
  content: string;
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
  /** Owner-only aggregates over customer conversations created since the given moment. */
  stats(ctx: TenantContext, options: { since: Date }): Promise<ConversationStats>;
  /** Owner-only. Customer conversations created since the given moment, per calendar day. */
  dailyCounts(ctx: TenantContext, options: { since: Date; timeZone: string }): Promise<DayCount[]>;
  /**
   * Owner-only. The earliest non-empty user message of each customer
   * conversation created since the given moment, newest conversations first.
   */
  firstUserMessages(
    ctx: TenantContext,
    options: { since: Date; limit?: number },
  ): Promise<FirstUserMessage[]>;
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
        if (created) return created;
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

    async stats(ctx, { since }) {
      assertOwner(ctx);
      const hasOrder = sql`exists (
        select 1 from ${orders}
        where ${orders.conversationId} = ${conversations.id}
          and ${orders.tenantId} = ${ctx.tenantId}
          and ${orders.status} <> 'draft'
      )`;
      const hasInquiry = sql`exists (
        select 1 from ${inquiries}
        where ${inquiries.conversationId} = ${conversations.id}
          and ${inquiries.tenantId} = ${ctx.tenantId}
      )`;
      const rows = await db
        .select({
          channel: conversations.channel,
          total: count(),
          withOrder: sql<number>`count(*) filter (where ${hasOrder})::int`,
          withInquiry: sql<number>`count(*) filter (where ${hasInquiry})::int`,
          withOutcome: sql<number>`count(*) filter (where ${hasOrder} or ${hasInquiry})::int`,
        })
        .from(conversations)
        .where(
          and(
            eq(conversations.tenantId, ctx.tenantId),
            eq(conversations.agent, "customer"),
            gte(conversations.createdAt, since),
          ),
        )
        .groupBy(conversations.channel);

      const stats: ConversationStats = {
        total: 0,
        byChannel: { storefront: 0, external_agent: 0, workspace: 0 },
        withOrder: 0,
        withInquiry: 0,
        withOutcome: 0,
      };
      for (const row of rows) {
        stats.total += row.total;
        stats.byChannel[row.channel] = row.total;
        stats.withOrder += row.withOrder;
        stats.withInquiry += row.withInquiry;
        stats.withOutcome += row.withOutcome;
      }
      return stats;
    },

    async dailyCounts(ctx, { since, timeZone }) {
      assertOwner(ctx);
      const day = sql<string>`to_char(${conversations.createdAt} at time zone ${timeZone}, 'YYYY-MM-DD')`;
      return db
        .select({ day, count: count() })
        .from(conversations)
        .where(
          and(
            eq(conversations.tenantId, ctx.tenantId),
            eq(conversations.agent, "customer"),
            gte(conversations.createdAt, since),
          ),
        )
        .groupBy(sql`1`)
        .orderBy(sql`1`);
    },

    async firstUserMessages(ctx, { since, limit }) {
      assertOwner(ctx);
      const max = clampLimit(limit);
      const result = await db.execute<{ conversationId: string; content: string }>(sql`
        select "conversationId", content from (
          select distinct on (${messages.conversationId})
            ${messages.conversationId} as "conversationId",
            ${messages.content} as content,
            ${conversations.createdAt} as "startedAt"
          from ${messages}
          inner join ${conversations} on ${conversations.id} = ${messages.conversationId}
          where ${conversations.tenantId} = ${ctx.tenantId}
            and ${conversations.agent} = 'customer'
            and ${conversations.createdAt} >= ${since}
            and ${messages.role} = 'user'
            and btrim(coalesce(${messages.content}, '')) <> ''
          order by ${messages.conversationId}, ${messages.createdAt} asc, ${messages.id} asc
        ) firsts
        order by "startedAt" desc, "conversationId"
        limit ${max}
      `);
      return result.rows;
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
