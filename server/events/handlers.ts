/**
 * Job handlers for the event worker. Every handler is idempotent: pg-boss
 * delivers at least once, so a job may run again after a crash or retry.
 */
import type { Db } from "@/db/client";
import { notifications } from "@/db/schema";
import { EVENTS, type EventName, type EventPayloads } from "./types";

export interface HandlerDeps {
  db: Db;
  log?: (message: string) => void;
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
  [EVENTS.fileUploaded]: acknowledgeOnly(EVENTS.fileUploaded),
  [EVENTS.ingestionCompleted]: acknowledgeOnly(EVENTS.ingestionCompleted),
  [EVENTS.modelConfirmed]: acknowledgeOnly(EVENTS.modelConfirmed),
  [EVENTS.tenantLive]: acknowledgeOnly(EVENTS.tenantLive),
  [EVENTS.conversationMessage]: acknowledgeOnly(EVENTS.conversationMessage),
};
