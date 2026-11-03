import { and, count as countAll, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { notifications } from "@/db/schema";
import { ServiceError, assertOwner, type TenantContext } from "../context";

export type Notification = typeof notifications.$inferSelect;

export interface ListNotificationsOptions {
  limit?: number;
  offset?: number;
  unreadOnly?: boolean;
}

export interface NotificationsService {
  list(ctx: TenantContext, options?: ListNotificationsOptions): Promise<Notification[]>;
  count(ctx: TenantContext, options?: { unreadOnly?: boolean }): Promise<number>;
  unreadCount(ctx: TenantContext): Promise<number>;
  markRead(ctx: TenantContext, id: string): Promise<Notification>;
  markAllRead(ctx: TenantContext): Promise<number>;
}

const MAX_LIMIT = 200;

export function createNotificationsService(db: Db): NotificationsService {
  const scope = (ctx: TenantContext, unreadOnly?: boolean) =>
    and(
      eq(notifications.tenantId, ctx.tenantId),
      unreadOnly ? isNull(notifications.readAt) : undefined,
    );

  async function count(ctx: TenantContext, options: { unreadOnly?: boolean } = {}) {
    assertOwner(ctx);
    const [row] = await db
      .select({ total: countAll() })
      .from(notifications)
      .where(scope(ctx, options.unreadOnly));
    return row?.total ?? 0;
  }

  return {
    async list(ctx, options = {}) {
      assertOwner(ctx);
      return db
        .select()
        .from(notifications)
        .where(scope(ctx, options.unreadOnly))
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), MAX_LIMIT))
        .offset(Math.max(Math.trunc(options.offset ?? 0), 0));
    },

    count,

    async unreadCount(ctx) {
      return count(ctx, { unreadOnly: true });
    },

    async markRead(ctx, id) {
      assertOwner(ctx);
      if (!z.uuid().safeParse(id).success) {
        throw new ServiceError("not_found", "Notification not found");
      }
      const [row] = await db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notifications.id, id),
            eq(notifications.tenantId, ctx.tenantId),
            isNull(notifications.readAt),
          ),
        )
        .returning();
      if (row) return row;
      const [existing] = await db
        .select()
        .from(notifications)
        .where(and(eq(notifications.id, id), eq(notifications.tenantId, ctx.tenantId)));
      if (!existing) throw new ServiceError("not_found", "Notification not found");
      return existing;
    },

    async markAllRead(ctx) {
      assertOwner(ctx);
      const rows = await db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(scope(ctx, true))
        .returning({ id: notifications.id });
      return rows.length;
    },
  };
}
