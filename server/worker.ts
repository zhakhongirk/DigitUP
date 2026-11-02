/**
 * Event worker: consumes pg-boss jobs and runs the idempotent handlers.
 */
import "dotenv/config";
import { createDb } from "@/db/client";
import { PgBossEventPublisher, startBoss } from "./events/boss";
import { handlers, type HandlerDeps } from "./events/handlers";
import { ALL_EVENTS, type EventName, type EventPayloads } from "./events/types";
import { runProposal } from "./agents/business/onboarding";
import { createServices } from "./container";
import { getOptionalLlmClient } from "./llm";
import { createProvisioningService } from "./services/provisioning";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret) throw new Error("AUTH_SECRET is not set");

  const database = createDb(url);
  const boss = await startBoss({ connectionString: url, supervise: true });
  const events = new PgBossEventPublisher(boss);
  const services = createServices({ db: database.db, events, authSecret });
  const llm = getOptionalLlmClient();
  const log = (message: string) => console.log(message);
  const deps: HandlerDeps = {
    db: database.db,
    log,
    provisioning: createProvisioningService({
      db: database.db,
      events,
      defaultModel: process.env.FIREWORKS_MODEL || "unconfigured",
    }),
    ingestion: services.ingestion,
    propose: async (input) => {
      const outcome = await runProposal({ services, llm, log }, input);
      log(`[worker] ingestion.completed: proposal ${outcome.status}`);
    },
  };

  for (const name of ALL_EVENTS) {
    const handler = handlers[name] as (
      payload: EventPayloads[EventName],
      deps: HandlerDeps,
    ) => Promise<void>;
    await boss.work<EventPayloads[EventName]>(name, async (jobs) => {
      for (const job of jobs) await handler(job.data, deps);
    });
  }
  console.log(`[worker] started; handling ${ALL_EVENTS.join(", ")}`);

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, shutting down`);
    await boss.stop({ graceful: true });
    await database.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  console.error("[worker] failed to start:", error);
  process.exit(1);
});
