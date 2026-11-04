import { fileURLToPath } from "node:url";
import { eq, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { createDb, type Db } from "./client";
import {
  auditEvents,
  changeSets,
  conversations as conversationsTable,
  inquiries,
  messages,
  notifications,
  orders as ordersTable,
  tenants,
} from "./schema";
import { barbershopActivity, shoeStoreActivity, type TenantActivity } from "./seed-data/activity";
import { barbershopModel } from "./seed-data/barbershop";
import { shoeStoreModel } from "./seed-data/shoe-store";
import type { BusinessModelInput } from "@/shared/business-model";
import { RecordingEventPublisher } from "@/server/events/types";
import { createApprovalsService } from "@/server/services/approvals";
import { createCatalogService, sizeOf, type OfferView } from "@/server/services/catalog";
import type { TenantContext } from "@/server/services/context";
import { createConversationsService } from "@/server/services/conversations";
import { createOrdersService, type OrderStatus } from "@/server/services/orders";
import { createTenancyService } from "@/server/services/tenancy";
import { appTimeZone } from "@/server/time";

export interface SeedResult {
  slug: string;
  status: "created" | "skipped";
  ownerEmail: string;
  ownerApiKey?: string;
  customerAgentApiKey?: string;
}

export const DEMO_PASSWORD = "demo-password-123";

export interface DemoTenant {
  slug: string;
  ownerEmail: string;
  model: BusinessModelInput;
  activity: TenantActivity;
}

const DEMO_TENANTS: DemoTenant[] = [
  {
    slug: "stride-shoes",
    ownerEmail: "owner@stride-shoes.demo",
    model: shoeStoreModel,
    activity: shoeStoreActivity,
  },
  {
    slug: "fade-factory",
    ownerEmail: "owner@fade-factory.demo",
    model: barbershopModel,
    activity: barbershopActivity,
  },
];

const ORDER_PATH: OrderStatus[] = ["received", "processing", "completed"];

const HOUR_MS = 3_600_000;
const ORDER_AGE_HOURS = [200, 80, 3, 30, 130, 9, 300, 2];
const INQUIRY_AGE_HOURS = [260, 140, 50, 5];
const CONVERSATION_AGE_HOURS = [320, 200, 120, 70, 20, 1];
const REJECTED_CHANGE_AGE_HOURS = 190;
const PENDING_CHANGE_AGE_HOURS = 12;

/** Hours back from `now` to the latest past `HH:MM` in the app time zone. */
export function hoursSince(placedAt: string, now: Date, timeZone: string = appTimeZone()): number {
  const [h = 0, m = 0] = placedAt.split(":").map(Number);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const elapsedMs = (part("hour") * 3600 + part("minute") * 60 + part("second")) * 1000;
  let diff = elapsedMs - (h * 60 + m) * 60_000;
  if (diff <= 0) diff += 24 * HOUR_MS;
  return diff / HOUR_MS;
}

const cycle = (hours: number[], index: number): number => hours[index % hours.length] ?? 0;
const earlier = (column: AnyColumn, ms: number): SQL =>
  sql`${column} - (${ms}::double precision * interval '1 millisecond')`;

type Shifts = {
  orders: [string, number][];
  inquiries: [string, number][];
  conversations: [string, number][];
  changeSets: [string, number][];
};

async function backdate(db: Db, tenantId: string, shifts: Shifts): Promise<void> {
  const groups = new Map<number, Record<keyof Shifts, string[]>>();
  for (const kind of Object.keys(shifts) as (keyof Shifts)[]) {
    for (const [id, hours] of shifts[kind]) {
      const group = groups.get(hours) ?? {
        orders: [],
        inquiries: [],
        conversations: [],
        changeSets: [],
      };
      group[kind].push(id);
      groups.set(hours, group);
    }
  }

  for (const [hours, group] of groups) {
    const ms = hours * HOUR_MS;
    const all = [...group.orders, ...group.inquiries, ...group.conversations, ...group.changeSets];
    if (group.orders.length) {
      await db
        .update(ordersTable)
        .set({
          createdAt: earlier(ordersTable.createdAt, ms),
          updatedAt: earlier(ordersTable.updatedAt, ms),
          submittedAt: earlier(ordersTable.submittedAt, ms),
        })
        .where(inArray(ordersTable.id, group.orders));
    }
    if (group.inquiries.length) {
      await db
        .update(inquiries)
        .set({
          createdAt: earlier(inquiries.createdAt, ms),
          updatedAt: earlier(inquiries.updatedAt, ms),
        })
        .where(inArray(inquiries.id, group.inquiries));
    }
    if (group.conversations.length) {
      await db
        .update(conversationsTable)
        .set({
          createdAt: earlier(conversationsTable.createdAt, ms),
          updatedAt: earlier(conversationsTable.updatedAt, ms),
        })
        .where(inArray(conversationsTable.id, group.conversations));
      await db
        .update(messages)
        .set({ createdAt: earlier(messages.createdAt, ms) })
        .where(inArray(messages.conversationId, group.conversations));
    }
    if (group.changeSets.length) {
      await db
        .update(changeSets)
        .set({
          createdAt: earlier(changeSets.createdAt, ms),
          resolvedAt: earlier(changeSets.resolvedAt, ms),
        })
        .where(inArray(changeSets.id, group.changeSets));
    }
    await db
      .update(auditEvents)
      .set({ createdAt: earlier(auditEvents.createdAt, ms) })
      .where(sql`${auditEvents.tenantId} = ${tenantId} and ${inArray(auditEvents.entityId, all)}`);
    await db
      .update(notifications)
      .set({
        createdAt: earlier(notifications.createdAt, ms),
        readAt: earlier(notifications.readAt, ms),
      })
      .where(inArray(notifications.refId, all));
  }

  const orderIds = shifts.orders.map(([id]) => id);
  const conversationIds = shifts.conversations.map(([id]) => id);
  if (orderIds.length) {
    await db
      .update(ordersTable)
      .set({
        createdAt: sql`least(${ordersTable.createdAt}, ${ordersTable.submittedAt}, ${ordersTable.updatedAt})`,
      })
      .where(inArray(ordersTable.id, orderIds));
  }
  if (conversationIds.length) {
    await db
      .update(conversationsTable)
      .set({
        createdAt: sql`least(${conversationsTable.createdAt}, (select min(${messages.createdAt}) from ${messages} where ${messages.conversationId} = ${conversationsTable.id}))`,
      })
      .where(inArray(conversationsTable.id, conversationIds));
  }
}

async function seedActivity(
  db: Db,
  tenantId: string,
  slug: string,
  activity: TenantActivity,
): Promise<void> {
  const events = new RecordingEventPublisher();
  const catalog = createCatalogService({ db, events });
  const conversations = createConversationsService({ db, events });
  const orders = createOrdersService({ db, events });
  const approvals = createApprovalsService(db);

  const customer: TenantContext = { tenantId, actor: "customer_agent" };
  const business: TenantContext = { tenantId, actor: "business_agent" };
  const owner: TenantContext = { tenantId, actor: "owner" };

  const items: OfferView[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await catalog.searchOffers(customer, { limit: 100, offset });
    items.push(...page.items);
    if (page.items.length < 100) break;
  }
  const offerOf = (title: string, size?: string) => {
    const variants = items.filter((o) => o.model === title);
    const found =
      variants.length > 0
        ? ((size ? variants.find((o) => sizeOf(o) === size) : undefined) ??
          variants.find((o) => o.availability === "in_stock") ??
          variants[0])
        : items.find((o) => o.title === title);
    if (!found) throw new Error(`${slug}: seed offer not found: ${title}`);
    return found;
  };
  const variantsOf = (title: string) => {
    const variants = items.filter((o) => o.model === title);
    return variants.length > 0 ? variants : [offerOf(title)];
  };

  const orderAges = activity.orders.map((spec, i) =>
    spec.placedAt ? hoursSince(spec.placedAt, new Date()) : cycle(ORDER_AGE_HOURS, i),
  );
  const inquiryAges = activity.inquiries.map((_, i) => cycle(INQUIRY_AGE_HOURS, i));
  const linkedAges = new Map<string, number>();
  const link = (key: string | undefined, age: number) => {
    if (key) linkedAges.set(key, Math.max(linkedAges.get(key) ?? 0, age));
  };
  activity.orders.forEach((o, i) => link(o.conversation, orderAges[i] ?? 0));
  activity.inquiries.forEach((q, i) => link(q.conversation, inquiryAges[i] ?? 0));

  const shifts: Shifts = { orders: [], inquiries: [], conversations: [], changeSets: [] };

  const conversationIds = new Map<string, string>();
  for (const [index, spec] of activity.conversations.entries()) {
    const conversation = await conversations.getOrCreate(customer, {
      agent: "customer",
      channel: spec.channel,
      sessionKey: `seed-${slug}-${spec.key}`,
    });
    await conversations.appendMessages(
      customer,
      conversation.id,
      spec.messages.map((m) => ({ role: m.role, content: m.text })),
    );
    conversationIds.set(spec.key, conversation.id);
    const linked = linkedAges.get(spec.key);
    shifts.conversations.push([
      conversation.id,
      linked === undefined ? cycle(CONVERSATION_AGE_HOURS, index) : linked + 2,
    ]);
  }

  for (const [index, spec] of activity.orders.entries()) {
    const { order } = await orders.createOrder(customer, {
      idempotencyKey: `seed-${slug}-order-${index + 1}`,
      source: spec.channel,
      conversationId: spec.conversation ? conversationIds.get(spec.conversation) : undefined,
      items: spec.items.map((i) => ({
        offerId: offerOf(i.title, i.size).id,
        quantity: i.quantity,
        ...(i.size ? { size: i.size } : {}),
      })),
      contact: spec.contact,
      ...(index % 2 === 0
        ? { fulfillment: "pickup" as const }
        : {
            fulfillment: "delivery" as const,
            deliveryAddress: "Almaty, Abay Ave 150",
            city: "Almaty",
          }),
    });
    await orders.submitOrder(customer, order.id);
    shifts.orders.push([order.id, orderAges[index] ?? 0]);
    if (spec.finalStatus === "submitted") continue;
    const steps = ORDER_PATH.slice(0, ORDER_PATH.indexOf(spec.finalStatus) + 1);
    for (const status of steps) await orders.updateOrderStatus(owner, order.id, status);
  }

  for (const [index, spec] of activity.inquiries.entries()) {
    const inquiry = await orders.createInquiry(customer, {
      subject: spec.subject,
      details: spec.details,
      contact: spec.contact,
      conversationId: spec.conversation ? conversationIds.get(spec.conversation) : undefined,
      offerIds: spec.offerTitles.map((t) => offerOf(t).id),
    });
    shifts.inquiries.push([inquiry.id, inquiryAges[index] ?? 0]);
    if (spec.status !== "new") await orders.updateInquiryStatus(owner, inquiry.id, spec.status);
  }

  const priceOps = (changes: { title: string; factor: number }[]) => [
    {
      op: "update_prices" as const,
      items: changes.flatMap(({ title, factor }) =>
        variantsOf(title).map((offer) => {
          if (offer.price === null) throw new Error(`${slug}: offer has no price: ${title}`);
          return { offerId: offer.id, price: Math.round((offer.price * factor) / 100) * 100 };
        }),
      ),
    },
  ];
  const rejected = await approvals.createChangeSet(business, {
    ops: priceOps(activity.rejectedPriceChanges.changes),
    reason: activity.rejectedPriceChanges.reason,
  });
  await approvals.rejectChangeSet(owner, rejected.id);
  const pending = await approvals.createChangeSet(business, {
    ops: priceOps(activity.pendingPriceChanges.changes),
    reason: activity.pendingPriceChanges.reason,
  });
  shifts.changeSets.push(
    [rejected.id, REJECTED_CHANGE_AGE_HOURS],
    [pending.id, PENDING_CHANGE_AGE_HOURS],
  );

  await backdate(db, tenantId, shifts);
}

export async function seedDemoTenants(
  db: Db,
  options: { authSecret: string; log?: (msg: string) => void; tenants?: DemoTenant[] },
): Promise<SeedResult[]> {
  const log = options.log ?? (() => {});
  const tenancy = createTenancyService(db, { authSecret: options.authSecret });
  const catalog = createCatalogService({ db, events: new RecordingEventPublisher() });
  const results: SeedResult[] = [];

  for (const demo of options.tenants ?? DEMO_TENANTS) {
    const existing = await tenancy.contextFromSlug(demo.slug, "system", { allowDraft: true });
    if (existing) {
      log(`${demo.slug}: already exists, skipped`);
      results.push({ slug: demo.slug, status: "skipped", ownerEmail: demo.ownerEmail });
      continue;
    }

    const tenant = await tenancy.createTenant({ name: demo.model.profile.name, slug: demo.slug });
    const system = { tenantId: tenant.id, actor: "system" as const };
    let applied: { offers: number };
    let ownerKey: { key: string };
    let agentKey: { key: string };
    try {
      await tenancy.createOwner(tenant.id, { email: demo.ownerEmail, password: DEMO_PASSWORD });
      applied = await catalog.applyBusinessModel(system, demo.model);
      await tenancy.setStatus(system, "live");
      await seedActivity(db, tenant.id, demo.slug, demo.activity);
      ownerKey = await tenancy.createApiKey({ tenantId: tenant.id, actor: "owner" }, "owner");
      agentKey = await tenancy.createApiKey(system, "customer_agent");
    } catch (error) {
      await db.delete(tenants).where(eq(tenants.id, tenant.id));
      throw error;
    }
    log(`${demo.slug}: created with ${applied.offers} offers`);
    results.push({
      slug: demo.slug,
      status: "created",
      ownerEmail: demo.ownerEmail,
      ownerApiKey: ownerKey.key,
      customerAgentApiKey: agentKey.key,
    });
  }
  return results;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  await import("dotenv/config");
  const url = process.env.DATABASE_URL;
  const authSecret = process.env.AUTH_SECRET;
  if (!url || !authSecret) {
    console.error("DATABASE_URL and AUTH_SECRET must be set (see .env.example)");
    process.exit(1);
  }
  const handle = createDb(url);
  try {
    const results = await seedDemoTenants(handle.db, { authSecret, log: console.log });
    console.log("\nSeed summary");
    for (const r of results) {
      console.log(`\n${r.slug} (${r.status})`);
      console.log(`  storefront: /s/${r.slug}`);
      console.log(`  owner login: ${r.ownerEmail} / ${DEMO_PASSWORD}`);
      if (r.ownerApiKey) console.log(`  owner API key: ${r.ownerApiKey}`);
      if (r.customerAgentApiKey) console.log(`  customer agent API key: ${r.customerAgentApiKey}`);
    }
  } finally {
    await handle.close();
  }
}
