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
import { assertOwner, ServiceError, type TenantContext } from "../context";

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

export type ChangeSet = typeof changeSets.$inferSelect;
export type ChangeSetStatus = ChangeSet["status"];

export interface ApprovalsService {
  createChangeSet(ctx: TenantContext, input: CreateChangeSetInput): Promise<ChangeSet>;
  getChangeSet(ctx: TenantContext, id: string): Promise<ChangeSet | null>;
  listChangeSets(
    ctx: TenantContext,
    filter?: { status?: ChangeSetStatus; limit?: number },
  ): Promise<ChangeSet[]>;
  /** Owner only. Applies all operations atomically; fails as a whole if any operation fails. */
  approveChangeSet(ctx: TenantContext, id: string): Promise<ChangeSet>;
  /** Owner only. */
  rejectChangeSet(ctx: TenantContext, id: string): Promise<ChangeSet>;
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

    async approveChangeSet(ctx, id) {
      assertOwner(ctx);
      return db.transaction(async (tx) => {
        const changeSet = await lockPending(tx, ctx, id);
        const ops = parseOrThrow(z.array(changeSetOpSchema), changeSet.ops, "stored change set");
        for (const op of ops) await applyOp(tx, ctx, op);

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
          after: { status: "applied" },
        });
        return applied!;
      });
    },

    async rejectChangeSet(ctx, id) {
      assertOwner(ctx);
      return db.transaction(async (tx) => {
        await lockPending(tx, ctx, id);
        const [rejected] = await tx
          .update(changeSets)
          .set({ status: "rejected", resolvedAt: new Date() })
          .where(eq(changeSets.id, id))
          .returning();
        await recordAudit(tx, ctx, {
          action: "change_set.rejected",
          entity: "change_set",
          entityId: id,
          before: { status: "pending" },
          after: { status: "rejected" },
        });
        return rejected!;
      });
    },
  };
}
