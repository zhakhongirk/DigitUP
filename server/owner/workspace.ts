import type { Services } from "@/server/container";
import type { AuditEvent } from "@/server/services/audit";
import type { CatalogStats } from "@/server/services/catalog";
import type { TenantContext } from "@/server/services/context";
import { actionLabel, auditChange } from "./audit";
import { buildInbox, type InboxItem } from "./inbox";
import type { Lang } from "@/server/storefront/i18n";
import { tr, trn } from "@/shared/owner-copy";
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

export function buildSetup(input: SetupInput, lang: Lang = "en"): SetupItem[] {
  const { slug, contacts, policies, health } = input;
  const hasContact = Boolean(contacts.phone || contacts.email || contacts.whatsapp);
  const hasHours = Boolean(policies.working_hours);
  const storefront = `/s/${slug}`;
  return [
    {
      key: "contacts",
      title: tr(lang, "ws.setup.contacts.title"),
      hint: tr(lang, "ws.setup.contacts.hint"),
      href: "/app/settings",
      done: hasContact && hasHours,
    },
    {
      key: "prices",
      title: tr(lang, "ws.setup.prices.title"),
      hint:
        health.priceOnRequest > 0
          ? `${trn(lang, "n.offersWithoutPrice", health.priceOnRequest)}.`
          : tr(lang, "ws.setup.prices.none"),
      href: "/app/catalog",
      done: health.priceOnRequest === 0,
    },
    {
      key: "share",
      title: tr(lang, "ws.setup.share.title"),
      hint: storefront,
      href: storefront,
      done: false,
      external: true,
      copy: storefront,
    },
    {
      key: "chat",
      title: tr(lang, "ws.setup.chat.title"),
      hint: tr(lang, "ws.setup.chat.hint"),
      href: storefront,
      done: input.chatted,
      external: true,
    },
    {
      key: "agents",
      title: tr(lang, "ws.setup.agents.title"),
      hint: tr(lang, "ws.setup.agents.hint"),
      href: "/app/agents",
      done: input.activeKeys > 0,
    },
  ];
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "2 orders, 1 question" for the new inbox items, or an empty string. */
export function inboxBreakdown(orders: number, inquiries: number, lang: Lang = "en"): string {
  const parts: string[] = [];
  if (orders > 0) parts.push(trn(lang, "n.order", orders));
  if (inquiries > 0) parts.push(trn(lang, "n.question", inquiries));
  return parts.join(", ");
}

export function feedSummary(
  view: Pick<WorkspaceView, "pendingCount" | "newOrders" | "newInquiries" | "health">,
  lang: Lang = "en",
): string {
  const { health } = view;
  const waiting: string[] = [];
  if (view.pendingCount > 0) waiting.push(trn(lang, "n.waitingApprovals", view.pendingCount));
  const inbox = view.newOrders + view.newInquiries;
  if (inbox > 0) waiting.push(tr(lang, "ws.inboxNew", { n: inbox }));
  const catalog: string[] = [];
  if (health.priceOnRequest > 0) {
    catalog.push(trn(lang, "n.offersOnRequest", health.priceOnRequest));
  }
  if (health.stockUnknown > 0) {
    catalog.push(tr(lang, "ws.stockUnknownCount", { n: health.stockUnknown }));
  }
  const parts: string[] = [];
  if (waiting.length > 0) parts.push(`${waiting.join(tr(lang, "ws.and"))}.`);
  if (catalog.length > 0) parts.push(`${catalog.join(", ")}.`);
  if (parts.length === 0) return tr(lang, "ws.allCaughtUp");
  return parts.join(" ");
}

export function inboxHref(item: Pick<InboxItem, "key">): string {
  return `/app/inbox?item=${encodeURIComponent(item.key)}`;
}

export function changeHref(id: string): string {
  return `/app/approvals?id=${encodeURIComponent(id)}`;
}

export function activityRow(event: AuditEvent, lang: Lang = "en"): ActivityRow {
  return {
    id: event.id,
    actor: event.actor,
    what: actionLabel(event.action, lang),
    change: auditChange(event, lang),
    at: event.createdAt,
  };
}

export async function loadWorkspace(
  services: Services,
  ctx: TenantContext,
  lang: Lang = "en",
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
      summary: ops ? summarize(ops, lang) : tr(lang, "ws.unreadable"),
      createdAt: cs.createdAt,
    };
  });

  return {
    setup: buildSetup(
      {
        slug: tenant.slug,
        contacts: model.profile.contacts,
        policies: model.policies,
        health,
        activeKeys: keys.filter((key) => !key.revokedAt).length,
        chatted: chats.length > 0,
      },
      lang,
    ),
    newOrders: orders.length,
    newInquiries: inquiries.length,
    newItems: buildInbox(orders, inquiries, undefined, lang).slice(0, ATTENTION_LIMIT),
    pendingCount: pending.length,
    pending: pending.slice(0, ATTENTION_LIMIT),
    health,
    activity: events.map((event) => activityRow(event, lang)),
  };
}
