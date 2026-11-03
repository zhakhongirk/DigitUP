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
import { log } from "./log";
import { getOptionalLlmClient } from "./llm";
import { readLlmModel } from "./llm/config";
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
  const note = (message: string) => log.info("worker.message", { message });
  const deps: HandlerDeps = {
    db: database.db,
    log: note,
    provisioning: createProvisioningService({
      db: database.db,
      events,
      defaultModel: readLlmModel() || "unconfigured",
    }),
    ingestion: services.ingestion,
    telegram: services.telegram,
    webhooks: services.webhooks,
    propose: async (input) => {
      const outcome = await runProposal({ services, llm, log: note }, input);
      note(`ingestion.completed: proposal ${outcome.status}`);
    },
  };

  for (const name of ALL_EVENTS) {
    const handler = handlers[name] as (
      payload: EventPayloads[EventName],
      deps: HandlerDeps,
    ) => Promise<void>;
    await boss.work<EventPayloads[EventName]>(name, async (jobs) => {
      for (const job of jobs) {
        const started = Date.now();
        try {
          await handler(job.data, deps);
          log.info("job.done", {
            job: name,
            jobId: job.id,
            outcome: "ok",
            durationMs: Date.now() - started,
          });
        } catch (error) {
          log.error("job.failed", {
            job: name,
            jobId: job.id,
            outcome: "error",
            durationMs: Date.now() - started,
            error,
          });
          throw error;
        }
      }
    });
  }
  const polling = new AbortController();
  const pollLoop = services.telegram.configured
    ? services.telegram.runPolling(polling.signal, (error) =>
        log.warn("telegram.poll_failed", { error }),
      )
    : Promise.resolve();
  log.info("worker.started", {
    events: ALL_EVENTS,
    telegram: services.telegram.configured ? "polling" : "not configured",
  });

  const shutdown = async (signal: string) => {
    log.info("worker.shutdown", { signal });
    polling.abort();
    await pollLoop;
    await boss.stop({ graceful: true });
    await database.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  log.error("worker.start_failed", { error });
  process.exit(1);
});
