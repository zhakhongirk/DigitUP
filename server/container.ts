import type { Db } from "@/db/client";
import { getDb } from "@/db/client";
import { PgBossEventPublisher, startBoss } from "./events/boss";
import type { EventPublisher } from "./events/types";
import { log } from "./log";
import { createApprovalsService, type ApprovalsService } from "./services/approvals";
import { createAuditService, type AuditService } from "./services/audit";
import { createCatalogService, type CatalogService } from "./services/catalog";
import { createConversationsService, type ConversationsService } from "./services/conversations";
import { getOptionalLlmClient } from "./llm";
import {
  createIntentService,
  createModelInterpreter,
  type IntentInterpreter,
  type IntentService,
} from "./services/intent";
import { defaultImageReader, type ImageReader } from "./services/ingestion/image";
import { createIngestionService, type IngestionService } from "./services/ingestion";
import { createNotificationsService, type NotificationsService } from "./services/notifications";
import { createOrdersService, type OrdersService } from "./services/orders";
import {
  createHttpTelegramClient,
  createTelegramService,
  telegramConfigFromEnv,
  type TelegramService,
} from "./services/telegram";
import { createTenancyService, type TenancyService } from "./services/tenancy";
import { createWebhookService, type WebhookService } from "./services/webhooks";
import { createFileStorage, type FileStorage } from "./storage";

export interface Services {
  tenancy: TenancyService;
  catalog: CatalogService;
  intent: IntentService;
  orders: OrdersService;
  conversations: ConversationsService;
  approvals: ApprovalsService;
  audit: AuditService;
  ingestion: IngestionService;
  notifications: NotificationsService;
  telegram: TelegramService;
  webhooks: WebhookService;
}

export interface ServiceDeps {
  db: Db;
  events: EventPublisher;
  authSecret: string;
  storage?: FileStorage;
  telegram?: TelegramService;
  interpret?: IntentInterpreter;
  readImage?: ImageReader;
}

function telegramFromEnv(db: Db): TelegramService {
  const config = telegramConfigFromEnv();
  return createTelegramService({
    db,
    client: config ? createHttpTelegramClient(config.token) : null,
    botUsername: config?.botUsername ?? null,
    appUrl: process.env.APP_URL,
    log: (message, fields) => log.warn(message, fields),
  });
}

export function createServices({
  db,
  events,
  authSecret,
  storage,
  telegram,
  interpret,
  readImage,
}: ServiceDeps): Services {
  const catalog = createCatalogService({ db, events });
  return {
    tenancy: createTenancyService(db, { authSecret }),
    catalog,
    intent: createIntentService({ db, catalog, interpret }),
    orders: createOrdersService({ db, events }),
    conversations: createConversationsService({ db, events }),
    approvals: createApprovalsService(db, events),
    audit: createAuditService(db),
    ingestion: createIngestionService({
      db,
      events,
      storage: storage ?? createFileStorage(),
      readImage: readImage ?? defaultImageReader,
    }),
    notifications: createNotificationsService(db),
    telegram: telegram ?? telegramFromEnv(db),
    webhooks: createWebhookService(db),
  };
}

const fastInterpreter: IntentInterpreter = async (ctx, input) => {
  const llm = getOptionalLlmClient("fast");
  return llm ? createModelInterpreter(llm)(ctx, input) : null;
};

let shared: Promise<Services> | undefined;

/**
 * Process-wide services for the web app. The queue client only enqueues jobs;
 * maintenance runs in the worker.
 */
export function getServices(): Promise<Services> {
  shared ??= (async () => {
    const url = process.env.DATABASE_URL;
    const authSecret = process.env.AUTH_SECRET;
    if (!url) throw new Error("DATABASE_URL is not set");
    if (!authSecret) throw new Error("AUTH_SECRET is not set");
    const boss = await startBoss({ connectionString: url, supervise: false });
    return createServices({
      db: getDb(),
      events: new PgBossEventPublisher(boss),
      authSecret,
      interpret: fastInterpreter,
    });
  })().catch((error: unknown) => {
    shared = undefined;
    throw error;
  });
  return shared;
}
