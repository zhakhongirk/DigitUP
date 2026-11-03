import { log } from "@/server/log";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { fromDrizzle, PgBoss } from "pg-boss";
import type { DbExecutor } from "@/db/client";
import {
  ALL_EVENTS,
  type EventName,
  type EventPayloads,
  type EventPublisher,
  type PublishOptions,
} from "./types";

export interface BossOptions {
  connectionString: string;
  /**
   * Run maintenance and scheduling. Only the worker does this; the web app
   * only enqueues jobs.
   */
  supervise: boolean;
}

export async function startBoss({ connectionString, supervise }: BossOptions): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, supervise, schedule: supervise, max: 5 });
  boss.on("error", (error) => log.error("pgboss.error", { error }));
  await boss.start();
  for (const name of ALL_EVENTS) {
    await boss.createQueue(name, { retryLimit: 3, retryDelay: 5, retryBackoff: true });
  }
  return boss;
}

export class PgBossEventPublisher implements EventPublisher {
  constructor(private readonly boss: PgBoss) {}

  async publish<N extends EventName>(
    executor: DbExecutor,
    name: N,
    data: EventPayloads[N],
    options?: PublishOptions,
  ): Promise<void> {
    await this.boss.send(name, data, {
      db: fromDrizzle(executor, sql),
      ...(options?.singletonKey ? { id: jobIdFor(name, options.singletonKey) } : {}),
    });
  }
}

/**
 * Deterministic job id for a (queue, key) pair. pg-boss ignores a second job
 * with an existing id, which gives exactly-once enqueueing per key regardless
 * of the queue policy.
 */
export function jobIdFor(name: string, key: string): string {
  const hex = createHash("sha256").update(`${name}:${key}`).digest("hex");
  // Format as an RFC 4122 version 5 style UUID.
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
