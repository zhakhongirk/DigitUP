/**
 * Database schema. Every tenant-owned table has an
 * indexed `tenant_id`; services are the only code that reads or writes these tables.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  boolean,
} from "drizzle-orm/pg-core";

const id = () =>
  uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const tenantStatus = pgEnum("tenant_status", ["draft", "live"]);
export const userRole = pgEnum("user_role", ["owner"]);
export const apiKeyKind = pgEnum("api_key_kind", ["owner", "customer_agent"]);
export const draftStatus = pgEnum("draft_status", ["draft", "confirmed", "rejected"]);
export const offerKind = pgEnum("offer_kind", ["product", "service", "other"]);
export const priceStatus = pgEnum("price_status", ["confirmed", "on_request"]);
export const availability = pgEnum("availability", ["in_stock", "out_of_stock", "unknown"]);
export const offerStatus = pgEnum("offer_status", ["active", "draft", "archived"]);
export const orderStatus = pgEnum("order_status", [
  "draft",
  "submitted",
  "received",
  "processing",
  "completed",
  "cancelled",
]);
export const orderSource = pgEnum("order_source", ["storefront", "external_agent"]);
export const inquiryStatus = pgEnum("inquiry_status", ["new", "in_progress", "completed"]);
export const agentName = pgEnum("agent_name", ["business", "customer"]);
export const conversationChannel = pgEnum("conversation_channel", [
  "workspace",
  "storefront",
  "external_agent",
]);
export const conversationStatus = pgEnum("conversation_status", [
  "new",
  "in_progress",
  "completed",
]);
export const messageRole = pgEnum("message_role", ["system", "user", "assistant", "tool"]);
export const sourceAssetStatus = pgEnum("source_asset_status", [
  "uploaded",
  "processing",
  "extracted",
  "failed",
]);
export const proposalRunStatus = pgEnum("proposal_run_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
]);
export const changeSetStatus = pgEnum("change_set_status", ["pending", "applied", "rejected"]);
export const actor = pgEnum("actor", ["owner", "business_agent", "customer_agent", "system"]);

export const tenants = pgTable("tenants", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  status: tenantStatus("status").notNull().default("draft"),
  createdAt: createdAt(),
});

export const users = pgTable(
  "users",
  {
    id: id(),
    tenantId: tenantId(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: userRole("role").notNull().default("owner"),
    sessionVersion: integer("session_version").notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [index("users_tenant_idx").on(t.tenantId)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    tenantId: tenantId(),
    kind: apiKeyKind("kind").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    /** First characters of the key, safe to show in the UI. */
    prefix: text("prefix").notNull(),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("api_keys_tenant_idx").on(t.tenantId)],
);

export const businessProfiles = pgTable("business_profiles", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  description: text("description").notNull().default(""),
  category: text("category"),
  contacts: jsonb("contacts").notNull().default({}),
  policies: jsonb("policies").notNull().default({}),
  missingInfo: jsonb("missing_info").notNull().default([]),
  updatedAt: updatedAt(),
});

export const businessModelDrafts = pgTable(
  "business_model_drafts",
  {
    id: id(),
    tenantId: tenantId(),
    payload: jsonb("payload").notNull(),
    status: draftStatus("status").notNull().default("draft"),
    /** Set when provisioning applied this draft to the catalog. */
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("business_model_drafts_tenant_idx").on(t.tenantId)],
);

export const offerTypes = pgTable(
  "offer_types",
  {
    id: id(),
    tenantId: tenantId(),
    /** Stable key used by the Business Model contract to reference the type. */
    key: text("key").notNull(),
    name: text("name").notNull(),
    kind: offerKind("kind").notNull(),
    attributeSchema: jsonb("attribute_schema").notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("offer_types_tenant_idx").on(t.tenantId),
    uniqueIndex("offer_types_tenant_key_uq").on(t.tenantId, t.key),
  ],
);

export const offers = pgTable(
  "offers",
  {
    id: id(),
    tenantId: tenantId(),
    offerTypeId: uuid("offer_type_id")
      .notNull()
      .references(() => offerTypes.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    category: text("category"),
    attributes: jsonb("attributes").notNull().default({}),
    price: numeric("price", { precision: 12, scale: 2, mode: "number" }),
    currency: text("currency"),
    priceStatus: priceStatus("price_status").notNull(),
    availability: availability("availability").notNull().default("unknown"),
    status: offerStatus("status").notNull().default("active"),
    /** Product photo: an https URL or a path under the app's public folder. */
    imageUrl: text("image_url"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("offers_tenant_idx").on(t.tenantId),
    index("offers_tenant_status_idx").on(t.tenantId, t.status, t.title),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: id(),
    tenantId: tenantId(),
    agent: agentName("agent").notNull(),
    channel: conversationChannel("channel").notNull(),
    status: conversationStatus("status").notNull().default("new"),
    /** Client-provided session id (storefront cookie, external agent session_id). */
    sessionKey: text("session_key"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("conversations_tenant_updated_idx").on(t.tenantId, t.updatedAt.desc()),
    index("conversations_tenant_agent_created_idx").on(t.tenantId, t.agent, t.createdAt),
    uniqueIndex("conversations_tenant_channel_session_uq").on(t.tenantId, t.channel, t.sessionKey),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: messageRole("role").notNull(),
    content: text("content"),
    toolCalls: jsonb("tool_calls"),
    createdAt: createdAt(),
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId, t.createdAt)],
);

export const orders = pgTable(
  "orders",
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    items: jsonb("items").notNull(),
    contact: jsonb("contact").notNull().default({}),
    fulfillment: text("fulfillment"),
    deliveryAddress: text("delivery_address"),
    city: text("city"),
    cancelReason: text("cancel_reason"),
    status: orderStatus("status").notNull().default("draft"),
    source: orderSource("source").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    total: numeric("total", { precision: 12, scale: 2, mode: "number" }),
    currency: text("currency"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
  },
  (t) => [
    index("orders_tenant_created_idx").on(t.tenantId, t.createdAt.desc(), t.id.desc()),
    index("orders_tenant_status_idx").on(t.tenantId, t.status),
    uniqueIndex("orders_tenant_idempotency_uq").on(t.tenantId, t.idempotencyKey),
  ],
);

export const inquiries = pgTable(
  "inquiries",
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    subject: text("subject").notNull(),
    details: text("details").notNull().default(""),
    contact: jsonb("contact").notNull().default({}),
    status: inquiryStatus("status").notNull().default("new"),
    answer: text("answer"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("inquiries_tenant_created_idx").on(t.tenantId, t.createdAt.desc(), t.id.desc()),
    index("inquiries_tenant_status_idx").on(t.tenantId, t.status),
  ],
);

export const sourceAssets = pgTable(
  "source_assets",
  {
    id: id(),
    tenantId: tenantId(),
    kind: text("kind").notNull(),
    filename: text("filename").notNull(),
    storagePath: text("storage_path").notNull(),
    extractedText: text("extracted_text"),
    status: sourceAssetStatus("status").notNull().default("uploaded"),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("source_assets_tenant_idx").on(t.tenantId)],
);

/** One analysis of the uploaded sources that ends with a Business Model draft. */
export const proposalRuns = pgTable(
  "proposal_runs",
  {
    id: id(),
    tenantId: tenantId(),
    status: proposalRunStatus("status").notNull().default("pending"),
    draftId: uuid("draft_id").references(() => businessModelDrafts.id, { onDelete: "set null" }),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("proposal_runs_tenant_idx").on(t.tenantId)],
);

export const agentConfigs = pgTable(
  "agent_configs",
  {
    id: id(),
    tenantId: tenantId(),
    agent: agentName("agent").notNull(),
    model: text("model").notNull(),
    promptOverrides: text("prompt_overrides"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("agent_configs_tenant_idx").on(t.tenantId),
    uniqueIndex("agent_configs_tenant_agent_uq").on(t.tenantId, t.agent),
  ],
);

export const changeSets = pgTable(
  "change_sets",
  {
    id: id(),
    tenantId: tenantId(),
    ops: jsonb("ops").notNull(),
    reason: text("reason").notNull().default(""),
    status: changeSetStatus("status").notNull().default("pending"),
    requestedBy: actor("requested_by").notNull(),
    createdAt: createdAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [index("change_sets_tenant_idx").on(t.tenantId, t.status)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    tenantId: tenantId(),
    actor: actor("actor").notNull(),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_events_tenant_idx").on(t.tenantId, t.createdAt)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    tenantId: tenantId(),
    kind: text("kind").notNull(),
    refId: uuid("ref_id").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_tenant_idx").on(t.tenantId, t.readAt),
    uniqueIndex("notifications_tenant_kind_ref_uq").on(t.tenantId, t.kind, t.refId),
  ],
);
