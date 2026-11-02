/**
 * Job handlers for the event worker. Every handler is idempotent: pg-boss
 * delivers at least once, so a job may run again after a crash or retry.
 */
import type { Db } from "@/db/client";
import { notifications } from "@/db/schema";
import type { IngestionService } from "@/server/services/ingestion";
import type { ProvisioningService } from "@/server/services/provisioning";
import { EVENTS, type EventName, type EventPayloads } from "./types";

export interface HandlerDeps {
  db: Db;
  log?: (message: string) => void;
  provisioning?: ProvisioningService;
  ingestion?: IngestionService;
  /** Builds a Business Model draft for a finished ingestion run. */
  propose?: (input: { tenantId: string; runId: string }) => Promise<void>;
}

export type EventHandler<N extends EventName> = (
  payload: EventPayloads[N],
  deps: HandlerDeps,
) => Promise<void>;

export type EventHandlers = { [N in EventName]: EventHandler<N> };

/** Inserting the same (tenant, kind, ref) twice is a no-op thanks to the unique index. */
async function notifyOwner(db: Db, tenantId: string, kind: string, refId: string) {
  await db
    .insert(notifications)
    .values({ tenantId, kind, refId })
    .onConflictDoNothing({
      target: [notifications.tenantId, notifications.kind, notifications.refId],
    });
}

/** For events that have no consumer yet: the job is acknowledged so the queue stays clean. */
function acknowledgeOnly(name: EventName): EventHandler<EventName> {
  return async (_payload, { log }) => {
    log?.(`[worker] ${name}: no consumer registered, job acknowledged`);
  };
}

export const handlers: EventHandlers = {
  [EVENTS.orderSubmitted]: async ({ tenantId, orderId }, { db }) =>
    notifyOwner(db, tenantId, "order", orderId),
  [EVENTS.inquirySubmitted]: async ({ tenantId, inquiryId }, { db }) =>
    notifyOwner(db, tenantId, "inquiry", inquiryId),
  [EVENTS.fileUploaded]: async ({ tenantId, sourceAssetId }, { ingestion, log }) => {
    if (!ingestion) throw new Error("ingestion is not configured in this worker");
    const asset = await ingestion.extractAsset(tenantId, sourceAssetId);
    log?.(
      `[worker] file.uploaded: ${asset?.filename ?? sourceAssetId} ${asset?.status ?? "missing"}`,
    );
  },
  [EVENTS.ingestionCompleted]: async (payload, { propose }) => {
    if (!propose) throw new Error("proposals are not configured in this worker");
    await propose(payload);
  },
  [EVENTS.modelConfirmed]: async ({ tenantId, draftId }, { provisioning, log }) => {
    if (!provisioning) throw new Error("provisioning is not configured in this worker");
    const outcome = await provisioning.provision({ tenantId, draftId });
    log?.(`[worker] model.confirmed: ${outcome.status} /s/${outcome.slug}`);
  },
  [EVENTS.tenantLive]: acknowledgeOnly(EVENTS.tenantLive),
  [EVENTS.conversationMessage]: acknowledgeOnly(EVENTS.conversationMessage),
};
