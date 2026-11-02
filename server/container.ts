import type { Db } from "@/db/client";
import { getDb } from "@/db/client";
import { PgBossEventPublisher, startBoss } from "./events/boss";
import type { EventPublisher } from "./events/types";
import { createApprovalsService, type ApprovalsService } from "./services/approvals";
import { createAuditService, type AuditService } from "./services/audit";
import { createCatalogService, type CatalogService } from "./services/catalog";
import { createConversationsService, type ConversationsService } from "./services/conversations";
import { createIngestionService, type IngestionService } from "./services/ingestion";
import { createOrdersService, type OrdersService } from "./services/orders";
import { createTenancyService, type TenancyService } from "./services/tenancy";
import { createFileStorage, type FileStorage } from "./storage";

export interface Services {
  tenancy: TenancyService;
  catalog: CatalogService;
  orders: OrdersService;
  conversations: ConversationsService;
  approvals: ApprovalsService;
  audit: AuditService;
  ingestion: IngestionService;
}

export interface ServiceDeps {
  db: Db;
  events: EventPublisher;
  authSecret: string;
  storage?: FileStorage;
}

export function createServices({ db, events, authSecret, storage }: ServiceDeps): Services {
  return {
    tenancy: createTenancyService(db, { authSecret }),
    catalog: createCatalogService({ db, events }),
    orders: createOrdersService({ db, events }),
    conversations: createConversationsService({ db, events }),
    approvals: createApprovalsService(db),
    audit: createAuditService(db),
    ingestion: createIngestionService({ db, events, storage: storage ?? createFileStorage() }),
  };
}

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
    return createServices({ db: getDb(), events: new PgBossEventPublisher(boss), authSecret });
  })().catch((error: unknown) => {
    shared = undefined;
    throw error;
  });
  return shared;
}
