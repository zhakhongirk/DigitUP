import type { DbExecutor } from "@/db/client";

/** Event names. Each one is a pg-boss queue. */
export const EVENTS = {
  fileUploaded: "file.uploaded",
  ingestionCompleted: "ingestion.completed",
  modelConfirmed: "model.confirmed",
  tenantLive: "tenant.live",
  orderSubmitted: "order.submitted",
  inquirySubmitted: "inquiry.submitted",
  conversationMessage: "conversation.message",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

export const ALL_EVENTS: readonly EventName[] = Object.values(EVENTS);

export interface EventPayloads {
  "file.uploaded": { tenantId: string; sourceAssetId: string };
  "ingestion.completed": { tenantId: string; sourceAssetIds: string[] };
  "model.confirmed": { tenantId: string; draftId: string };
  "tenant.live": { tenantId: string };
  "order.submitted": { tenantId: string; orderId: string };
  "inquiry.submitted": { tenantId: string; inquiryId: string };
  "conversation.message": { tenantId: string; conversationId: string; messageId: string };
}

export interface PublishOptions {
  /** Deduplicates jobs: a second publish with the same key for the same event is dropped. */
  singletonKey?: string;
}

/**
 * Publishes events as part of the caller's database transaction, so a job
 * exists exactly when the write that caused it was committed.
 */
export interface EventPublisher {
  publish<N extends EventName>(
    executor: DbExecutor,
    name: N,
    data: EventPayloads[N],
    options?: PublishOptions,
  ): Promise<void>;
}

/** Publisher for code paths and tests that do not need a queue. */
export class RecordingEventPublisher implements EventPublisher {
  readonly events: { name: EventName; data: unknown; options?: PublishOptions }[] = [];

  async publish<N extends EventName>(
    _executor: DbExecutor,
    name: N,
    data: EventPayloads[N],
    options?: PublishOptions,
  ): Promise<void> {
    this.events.push({ name, data, options });
  }

  ofType<N extends EventName>(name: N): EventPayloads[N][] {
    return this.events.filter((e) => e.name === name).map((e) => e.data as EventPayloads[N]);
  }
}
