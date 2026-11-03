import { and, count, desc, eq, ne } from "drizzle-orm";
import type { Db, DbExecutor } from "@/db/client";
import { auditEvents } from "@/db/schema";
import type { TenantContext } from "../context";

export type AuditEvent = typeof auditEvents.$inferSelect;

export interface AuditEntry {
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

/**
 * Records a write. Call it with the same transaction as the write itself so
 * the change and its audit record commit or roll back together.
 */
export async function recordAudit(
  tx: DbExecutor,
  ctx: TenantContext,
  entry: AuditEntry,
): Promise<void> {
  await tx.insert(auditEvents).values({
    tenantId: ctx.tenantId,
    actor: ctx.actor,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
}

export interface AuditService {
  list(
    ctx: TenantContext,
    options?: {
      entity?: string;
      entityId?: string;
      excludeAction?: string;
      actor?: AuditEvent["actor"];
      limit?: number;
      offset?: number;
    },
  ): Promise<AuditEvent[]>;
  count(
    ctx: TenantContext,
    options?: { excludeAction?: string; actor?: AuditEvent["actor"] },
  ): Promise<number>;
}

export function createAuditService(db: Db): AuditService {
  return {
    async list(ctx, options = {}) {
      const conditions = [eq(auditEvents.tenantId, ctx.tenantId)];
      if (options.entity) conditions.push(eq(auditEvents.entity, options.entity));
      if (options.entityId) conditions.push(eq(auditEvents.entityId, options.entityId));
      if (options.excludeAction) conditions.push(ne(auditEvents.action, options.excludeAction));
      if (options.actor) conditions.push(eq(auditEvents.actor, options.actor));
      return db
        .select()
        .from(auditEvents)
        .where(and(...conditions))
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
        .limit(Math.min(options.limit ?? 100, 500))
        .offset(Math.max(Math.trunc(options.offset ?? 0), 0));
    },

    async count(ctx, options = {}) {
      const conditions = [eq(auditEvents.tenantId, ctx.tenantId)];
      if (options.excludeAction) conditions.push(ne(auditEvents.action, options.excludeAction));
      if (options.actor) conditions.push(eq(auditEvents.actor, options.actor));
      const [row] = await db
        .select({ total: count() })
        .from(auditEvents)
        .where(and(...conditions));
      return row?.total ?? 0;
    },
  };
}
