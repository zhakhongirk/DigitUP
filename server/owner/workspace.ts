import type { Services } from "@/server/container";
import type { AuditEvent } from "@/server/services/audit";
import type { CatalogStats } from "@/server/services/catalog";
import type { TenantContext } from "@/server/services/context";
import { actionLabel, auditChange } from "./audit";
import { buildInbox, type InboxItem } from "./inbox";
import { parseOps, summarize } from "./changes";

export const ATTENTION_LIMIT = 4;
export const ACTIVITY_LIMIT = 5;

export interface CatalogHealth {
  active: number;
  priceOnRequest: number;
  stockUnknown: number;
}

export interface AttentionChange {
  id: string;
  summary: string;
  createdAt: Date;
}

export interface ActivityRow {
  id: string;
  actor: AuditEvent["actor"];
  what: string;
  change: string;
  at: Date;
}

export interface SetupItem {
  key: string;
  title: string;
  hint: string;
  href: string;
  done: boolean;
  external?: boolean;
  copy?: string;
}

export interface SetupInput {
  slug: string;
  contacts: Partial<Record<string, string | null | undefined>>;
  policies: Partial<Record<string, string | null | undefined>>;
  health: CatalogHealth;
  activeKeys: number;
  chatted: boolean;
}

export interface WorkspaceView {
  setup: SetupItem[];
  newOrders: number;
  newInquiries: number;
  newItems: InboxItem[];
  pendingCount: number;
  pending: AttentionChange[];
  health: CatalogHealth;
  activity: ActivityRow[];
}

export function healthFromStats(stats: CatalogStats): CatalogHealth {
  return {
    active: stats.byStatus.active,
    priceOnRequest: stats.priceOnRequest,
    stockUnknown: stats.availabilityUnknown,
  };
}

export function buildSetup(input: SetupInput): SetupItem[] {
  const { slug, contacts, policies, health } = input;
  const hasContact = Boolean(contacts.phone || contacts.email || contacts.whatsapp);
  const hasHours = Boolean(policies.working_hours);
  const storefront = `/s/${slug}`;
  return [
    {
      key: "contacts",
      title: "Add contacts and working hours",
      hint: "Shoppers and agents see them on your storefront.",
      href: "/app/settings",
      done: hasContact && hasHours,
    },
    {
      key: "prices",
      title: "Set prices for offers marked price on request",
      hint:
        health.priceOnRequest > 0
          ? `${plural(health.priceOnRequest, "offer")} without a price.`
          : "Every offer has a price.",
      href: "/app/catalog",
      done: health.priceOnRequest === 0,
    },
    {
      key: "share",
      title: "Share your storefront link",
      hint: storefront,
      href: storefront,
      done: false,
      external: true,
      copy: storefront,
    },
    {
      key: "chat",
      title: "Try the store chat",
      hint: "Ask it a question the way a shopper would.",
      href: storefront,
      done: input.chatted,
      external: true,
    },
    {
      key: "agents",
      title: "Connect an AI agent",
      hint: "Create a key so an assistant can work with your store.",
      href: "/app/agents",
      done: input.activeKeys > 0,
    },
  ];
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "2 orders, 1 question" for the new inbox items, or an empty string. */
export function inboxBreakdown(orders: number, inquiries: number): string {
  const parts: string[] = [];
  if (orders > 0) parts.push(plural(orders, "order"));
  if (inquiries > 0) parts.push(plural(inquiries, "question"));
  return parts.join(", ");
}

export function inboxHref(item: Pick<InboxItem, "key">): string {
  return `/app/inbox?item=${encodeURIComponent(item.key)}`;
}

export function changeHref(id: string): string {
  return `/app/approvals?id=${encodeURIComponent(id)}`;
}

export function activityRow(event: AuditEvent): ActivityRow {
  return {
    id: event.id,
    actor: event.actor,
    what: actionLabel(event.action),
    change: auditChange(event),
    at: event.createdAt,
  };
}

export async function loadWorkspace(
  services: Services,
  ctx: TenantContext,
): Promise<WorkspaceView> {
  const [orders, inquiries, changeSets, stats, events, model, tenant, keys, chats] =
    await Promise.all([
      services.orders.listOrders(ctx, { status: "submitted", limit: 200 }),
      services.orders.listInquiries(ctx, { status: "new", limit: 200 }),
      services.approvals.listChangeSets(ctx, { status: "pending", limit: 200 }),
      services.catalog.catalogStats(ctx),
      services.audit.list(ctx, { limit: ACTIVITY_LIMIT, excludeAction: "conversation.created" }),
      services.catalog.getBusinessModel(ctx),
      services.tenancy.getTenant(ctx),
      services.tenancy.listApiKeys(ctx),
      services.conversations.list(ctx, { limit: 1 }),
    ]);
  const health = healthFromStats(stats);

  const pending = changeSets.map((cs) => {
    const ops = parseOps(cs.ops);
    return {
      id: cs.id,
      summary: ops ? summarize(ops) : "Unreadable approval request",
      createdAt: cs.createdAt,
    };
  });

  return {
    setup: buildSetup({
      slug: tenant.slug,
      contacts: model.profile.contacts,
      policies: model.policies,
      health,
      activeKeys: keys.filter((key) => !key.revokedAt).length,
      chatted: chats.length > 0,
    }),
    newOrders: orders.length,
    newInquiries: inquiries.length,
    newItems: buildInbox(orders, inquiries).slice(0, ATTENTION_LIMIT),
    pendingCount: pending.length,
    pending: pending.slice(0, ATTENTION_LIMIT),
    health,
    activity: events.map(activityRow),
  };
}
