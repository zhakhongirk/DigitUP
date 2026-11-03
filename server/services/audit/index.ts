import { and, count, desc, eq } from "drizzle-orm";
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
    options?: { entity?: string; entityId?: string; limit?: number; offset?: number },
  ): Promise<AuditEvent[]>;
  count(ctx: TenantContext): Promise<number>;
}

export function createAuditService(db: Db): AuditService {
  return {
    async list(ctx, options = {}) {
      const conditions = [eq(auditEvents.tenantId, ctx.tenantId)];
      if (options.entity) conditions.push(eq(auditEvents.entity, options.entity));
      if (options.entityId) conditions.push(eq(auditEvents.entityId, options.entityId));
      return db
        .select()
        .from(auditEvents)
        .where(and(...conditions))
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
        .limit(Math.min(options.limit ?? 100, 500))
        .offset(Math.max(Math.trunc(options.offset ?? 0), 0));
    },

    async count(ctx) {
      const [row] = await db
        .select({ total: count() })
        .from(auditEvents)
        .where(eq(auditEvents.tenantId, ctx.tenantId));
      return row?.total ?? 0;
    },
  };
}
