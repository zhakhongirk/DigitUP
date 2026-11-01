/**
 * Launches a tenant after the owner confirms its Business Model: applies the
 * draft to the catalog, creates agent configs, and makes the store live.
 * Safe to run more than once for the same draft.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { agentConfigs, businessModelDrafts, tenants } from "@/db/schema";
import { EVENTS, type EventPublisher } from "@/server/events/types";
import { businessModelSchema } from "@/shared/business-model";
import { recordAudit } from "../audit";
import { applyBusinessModelTx } from "../catalog/ops";
import { ServiceError, type TenantContext } from "../context";

export type ProvisionOutcome =
  | { status: "provisioned"; slug: string; offers: number }
  | { status: "already_applied"; slug: string };

export interface ProvisioningService {
  provision(input: { tenantId: string; draftId: string }): Promise<ProvisionOutcome>;
}

export interface ProvisioningDeps {
  db: Db;
  events: EventPublisher;
  /** Model recorded in agent configs. */
  defaultModel: string;
}

export function createProvisioningService({
  db,
  events,
  defaultModel,
}: ProvisioningDeps): ProvisioningService {
  return {
    async provision({ tenantId, draftId }) {
      const ctx: TenantContext = { tenantId, actor: "system" };
      return db.transaction(async (tx) => {
        const [draft] = await tx
          .select()
          .from(businessModelDrafts)
          .where(
            and(eq(businessModelDrafts.id, draftId), eq(businessModelDrafts.tenantId, tenantId)),
          )
          .for("update");
        if (!draft) throw new ServiceError("not_found", "Draft not found");
        if (draft.status !== "confirmed") {
          throw new ServiceError("conflict", "Only a confirmed draft can be provisioned");
        }

        const [tenant] = await tx
          .select()
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .for("update");
        if (!tenant) throw new ServiceError("not_found", "Tenant not found");
        if (draft.appliedAt) return { status: "already_applied", slug: tenant.slug };

        const model = businessModelSchema.parse(draft.payload);
        const counts = await applyBusinessModelTx(tx, ctx, model);

        for (const agent of ["business", "customer"] as const) {
          await tx
            .insert(agentConfigs)
            .values({ tenantId, agent, model: defaultModel })
            .onConflictDoNothing({ target: [agentConfigs.tenantId, agentConfigs.agent] });
        }

        if (tenant.status !== "live") {
          await tx.update(tenants).set({ status: "live" }).where(eq(tenants.id, tenantId));
          await recordAudit(tx, ctx, {
            action: "tenant.status_changed",
            entity: "tenant",
            entityId: tenantId,
            before: { status: tenant.status },
            after: { status: "live" },
          });
        }

        await tx
          .update(businessModelDrafts)
          .set({ appliedAt: new Date() })
          .where(eq(businessModelDrafts.id, draftId));
        await recordAudit(tx, ctx, {
          action: "tenant.provisioned",
          entity: "business_model_draft",
          entityId: draftId,
          after: { slug: tenant.slug, ...counts },
        });
        await events.publish(tx, EVENTS.tenantLive, { tenantId }, { singletonKey: draftId });

        return { status: "provisioned", slug: tenant.slug, offers: counts.offers };
      });
    },
  };
}
