/**
 * Change sets for high-risk catalog operations. The Business MCP creates a
 * change set instead of applying the change; the owner approves it in the UI,
 * and only then are the operations applied, in one transaction.
 */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbTx } from "@/db/client";
import { changeSets } from "@/db/schema";
import { EVENTS, type EventPublisher } from "@/server/events/types";
import { recordAudit } from "../audit";
import {
  archiveOffersTx,
  offerUpsertSchema,
  parseOrThrow,
  priceUpdateSchema,
  updatePricesTx,
  upsertOffersTx,
} from "../catalog/ops";
import { assertNotStaff, assertOwner, ServiceError, type TenantContext } from "../context";

export const changeSetOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("update_prices"), items: z.array(priceUpdateSchema).min(1).max(500) }),
  z.object({ op: z.literal("delete_offers"), offerIds: z.array(z.uuid()).min(1).max(500) }),
  z.object({ op: z.literal("upsert_offers"), offers: z.array(offerUpsertSchema).min(1).max(500) }),
]);
export type ChangeSetOp = z.infer<typeof changeSetOpSchema>;

export const createChangeSetSchema = z.object({
  ops: z.array(changeSetOpSchema).min(1).max(20),
  reason: z.string().trim().max(2000).default(""),
});
export type CreateChangeSetInput = z.input<typeof createChangeSetSchema>;

/** Identifies one row of a change set: operation index and position inside the operation. */
export function changeRowIds(ops: ChangeSetOp[]): string[] {
  return ops.flatMap((op, index) => {
    const count =
      op.op === "update_prices"
        ? op.items.length
        : op.op === "delete_offers"
          ? op.offerIds.length
          : op.offers.length;
    return Array.from({ length: count }, (_, n) => `${index}:${n}`);
  });
}

function selectRows(ops: ChangeSetOp[], selected: ReadonlySet<string>, keep = true): ChangeSetOp[] {
  const picked = <T>(items: T[], index: number) =>
    items.filter((_, n) => selected.has(`${index}:${n}`) === keep);
  const result: ChangeSetOp[] = [];
  ops.forEach((op, index) => {
    if (op.op === "update_prices") {
      const items = picked(op.items, index);
      if (items.length > 0) result.push({ op: op.op, items });
    } else if (op.op === "delete_offers") {
      const offerIds = picked(op.offerIds, index);
      if (offerIds.length > 0) result.push({ op: op.op, offerIds });
    } else {
      const offers = picked(op.offers, index);
      if (offers.length > 0) result.push({ op: op.op, offers });
    }
  });
  return result;
}

export type ChangeSet = typeof changeSets.$inferSelect;
export type ChangeSetStatus = ChangeSet["status"];

export interface ApprovalsService {
  createChangeSet(ctx: TenantContext, input: CreateChangeSetInput): Promise<ChangeSet>;
  getChangeSet(ctx: TenantContext, id: string): Promise<ChangeSet | null>;
  listChangeSets(
    ctx: TenantContext,
    filter?: { status?: ChangeSetStatus; limit?: number },
  ): Promise<ChangeSet[]>;
  /**
   * Owner only. Applies the operations atomically; fails as a whole if any operation fails.
   * With `rowIds` only those rows are applied and the rest are dropped; without it all rows are applied.
   */
  approveChangeSet(ctx: TenantContext, id: string, rowIds?: string[]): Promise<ChangeSet>;
  /**
   * Owner only. With `rowIds` only those rows are rejected and the rest stay pending;
   * the change set is rejected once no rows are left. Without it all rows are rejected.
   */
  rejectChangeSet(ctx: TenantContext, id: string, rowIds?: string[]): Promise<ChangeSet>;
}

async function applyOp(tx: DbTx, ctx: TenantContext, op: ChangeSetOp): Promise<void> {
  switch (op.op) {
    case "update_prices":
      await updatePricesTx(tx, ctx, op.items);
      return;
    case "delete_offers":
      await archiveOffersTx(tx, ctx, op.offerIds);
      return;
    case "upsert_offers":
      await upsertOffersTx(tx, ctx, op.offers);
      return;
  }
}

export function createApprovalsService(db: Db, events?: EventPublisher): ApprovalsService {
  async function lockPending(tx: DbTx, ctx: TenantContext, id: string): Promise<ChangeSet> {
    const [changeSet] = await tx
      .select()
      .from(changeSets)
      .where(and(eq(changeSets.id, id), eq(changeSets.tenantId, ctx.tenantId)))
      .for("update");
    if (!changeSet) throw new ServiceError("not_found", "Change set not found");
    if (changeSet.status !== "pending") {
      throw new ServiceError("conflict", `Change set is already ${changeSet.status}`);
    }
    return changeSet;
  }

  return {
    async createChangeSet(ctx, rawInput) {
      const input = parseOrThrow(createChangeSetSchema, rawInput, "change set");
      return db.transaction(async (tx) => {
        const [changeSet] = await tx
          .insert(changeSets)
          .values({
            tenantId: ctx.tenantId,
            ops: input.ops,
            reason: input.reason,
            requestedBy: ctx.actor,
          })
          .returning();
        await recordAudit(tx, ctx, {
          action: "change_set.created",
          entity: "change_set",
          entityId: changeSet!.id,
          after: { ops: input.ops.map((op) => op.op), reason: input.reason },
        });
        if (ctx.actor !== "owner") {
          await events?.publish(
            tx,
            EVENTS.changeSetCreated,
            { tenantId: ctx.tenantId, changeSetId: changeSet!.id },
            { singletonKey: changeSet!.id },
          );
        }
        return changeSet!;
      });
    },

    async getChangeSet(ctx, id) {
      const [changeSet] = await db
        .select()
        .from(changeSets)
        .where(and(eq(changeSets.id, id), eq(changeSets.tenantId, ctx.tenantId)));
      return changeSet ?? null;
    },

    async listChangeSets(ctx, filter = {}) {
      const conditions = [eq(changeSets.tenantId, ctx.tenantId)];
      if (filter.status) conditions.push(eq(changeSets.status, filter.status));
      return db
        .select()
        .from(changeSets)
        .where(and(...conditions))
        .orderBy(desc(changeSets.createdAt))
        .limit(Math.min(Math.max(filter.limit ?? 50, 1), 200));
    },

    async approveChangeSet(ctx, id, rowIds) {
      assertOwner(ctx);
      assertNotStaff(ctx);
      return db.transaction(async (tx) => {
        const changeSet = await lockPending(tx, ctx, id);
        const ops = parseOrThrow(z.array(changeSetOpSchema), changeSet.ops, "stored change set");
        const all = changeRowIds(ops);
        const selected = rowIds === undefined ? all : [...new Set(rowIds)];
        if (selected.length === 0) {
          throw new ServiceError("invalid", "Select at least one change to apply");
        }
        const known = new Set(all);
        if (selected.some((rowId) => !known.has(rowId))) {
          throw new ServiceError("invalid", "Some selected changes do not belong to this request");
        }
        const chosen = new Set(selected);
        for (const op of selectRows(ops, chosen)) await applyOp(tx, ctx, op);

        const [applied] = await tx
          .update(changeSets)
          .set({ status: "applied", resolvedAt: new Date() })
          .where(eq(changeSets.id, id))
          .returning();
        await recordAudit(tx, ctx, {
          action: "change_set.applied",
          entity: "change_set",
          entityId: id,
          before: { status: "pending" },
          after: {
            status: "applied",
            applied: selected,
            skipped: all.filter((rowId) => !chosen.has(rowId)),
          },
        });
        return applied!;
      });
    },

    async rejectChangeSet(ctx, id, rowIds) {
      assertOwner(ctx);
      assertNotStaff(ctx);
      return db.transaction(async (tx) => {
        const changeSet = await lockPending(tx, ctx, id);
        const ops = parseOrThrow(z.array(changeSetOpSchema), changeSet.ops, "stored change set");
        const all = changeRowIds(ops);
        const selected = rowIds === undefined ? all : [...new Set(rowIds)];
        if (selected.length === 0) {
          throw new ServiceError("invalid", "Select at least one change to reject");
        }
        const known = new Set(all);
        if (selected.some((rowId) => !known.has(rowId))) {
          throw new ServiceError("invalid", "Some selected changes do not belong to this request");
        }
        const chosen = new Set(selected);
        const left = all.filter((rowId) => !chosen.has(rowId));
        const done = left.length === 0;
        const [updated] = await tx
          .update(changeSets)
          .set(
            done
              ? { status: "rejected", resolvedAt: new Date() }
              : { ops: selectRows(ops, chosen, false) },
          )
          .where(eq(changeSets.id, id))
          .returning();
        await recordAudit(tx, ctx, {
          action: "change_set.rejected",
          entity: "change_set",
          entityId: id,
          before: { status: "pending" },
          after: { status: done ? "rejected" : "pending", rejected: selected, left },
        });
        return updated!;
      });
    },
  };
}
