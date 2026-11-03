import type { Services } from "@/server/container";
import type { MissedQuery } from "@/server/services/catalog/search-misses";
import type { TenantContext } from "@/server/services/context";
import type { Conversation, ConversationStats, DayCount } from "@/server/services/conversations";
import type { IntentStats } from "@/server/services/intent";
import type { DailyOrderCounts, Inquiry, OrderStats } from "@/server/services/orders";
import { appTimeZone } from "@/server/time";
import type { Lang } from "@/server/storefront/i18n";
import { formatPrice } from "@/shared/format";
import { tr, type TextKey } from "@/shared/owner-copy";

export const ANALYTICS_RANGES = [7, 30] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

export function parseRange(value: unknown): AnalyticsRange {
  const n = Number(value);
  return ANALYTICS_RANGES.find((range) => range === n) ?? 30;
}

const DAY = 24 * 3600 * 1000;

export interface ChannelCount {
  channel: Conversation["channel"];
  label: string;
  count: number;
}

const CHANNEL_LABELS: Record<Conversation["channel"], string> = {
  storefront: "Storefront chat",
  external_agent: "External agents",
  workspace: "Workspace",
};

const CHANNEL_KEYS: Record<Conversation["channel"], TextKey> = {
  storefront: "common.storefrontChat",
  external_agent: "common.externalAgents",
  workspace: "common.workspaceChannel",
};

export function channelCounts(
  byChannel: ConversationStats["byChannel"],
  lang: Lang = "en",
): ChannelCount[] {
  return (["storefront", "external_agent"] as const).map((channel) => ({
    channel,
    label: lang === "en" ? CHANNEL_LABELS[channel] : tr(lang, CHANNEL_KEYS[channel]),
    count: byChannel[channel],
  }));
}

export function orderValue(value: OrderStats["value"], lang: Lang = "en"): string[] {
  return value.map(({ currency, total }) => formatPrice(total, currency, lang));
}

export interface AgentOutcome {
  conversations: number;
  toOrder: number;
  toInquiry: number;
  resolvedShare: number | null;
  unresolved: number;
}

export function agentOutcome(
  conversations: ConversationStats,
  inquiries: OrderStats["inquiries"],
): AgentOutcome {
  return {
    conversations: conversations.total,
    toOrder: conversations.withOrder,
    toInquiry: conversations.withInquiry,
    resolvedShare: conversations.total > 0 ? conversations.withOutcome / conversations.total : null,
    unresolved: inquiries.new,
  };
}

export type TopOffer = OrderStats["topOffers"][number];

export interface TopQuery {
  text: string;
  count: number;
}

const QUERY_MAX = 80;

const TOOL_CALL = /^[a-z]+(?:_[a-z]+)+\s*[:(]/;

export function isPlainQuestion(text: string): boolean {
  if (TOOL_CALL.test(text)) return false;
  return !/^[{[]/.test(text) && !/"[\w-]+"\s*:/.test(text);
}

export function topQueries(firstMessages: string[], limit = 6): TopQuery[] {
  const byKey = new Map<string, TopQuery>();
  for (const raw of firstMessages) {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text || !isPlainQuestion(text)) continue;
    const key = text.toLowerCase().replace(/[.!?\s]+$/, "");
    const shown = text.length > QUERY_MAX ? `${text.slice(0, QUERY_MAX - 1)}…` : text;
    const entry = byKey.get(key) ?? { text: shown, count: 0 };
    entry.count += 1;
    byKey.set(key, entry);
  }
  return [...byKey.values()]
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, limit);
}

export interface DayPoint {
  day: string;
  conversations: number;
  orders: number;
  inquiries: number;
}

function dayKey(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export function dailySeries(
  now: Date,
  range: number,
  counts: {
    conversations: DayCount[];
    orders: DailyOrderCounts["orders"];
    inquiries: DailyOrderCounts["inquiries"];
  },
  timeZone: string,
): DayPoint[] {
  const lookup = (rows: DayCount[]) => new Map(rows.map((row) => [row.day, row.count]));
  const conversations = lookup(counts.conversations);
  const orders = lookup(counts.orders);
  const inquiries = lookup(counts.inquiries);
  const points: DayPoint[] = [];
  for (let i = range - 1; i >= 0; i--) {
    const day = dayKey(new Date(now.getTime() - i * DAY), timeZone);
    if (points.at(-1)?.day === day) continue;
    points.push({
      day,
      conversations: conversations.get(day) ?? 0,
      orders: orders.get(day) ?? 0,
      inquiries: inquiries.get(day) ?? 0,
    });
  }
  return points;
}

export interface AgentAnswers {
  findOffers: number;
  rated: number;
  flaggedShare: number | null;
  rawShare: number | null;
}

export function agentAnswers(stats: IntentStats): AgentAnswers {
  return {
    findOffers: stats.findOffers,
    rated: stats.reported,
    flaggedShare: stats.reported > 0 ? (stats.wrong + stats.incomplete) / stats.reported : null,
    rawShare: stats.findOffers > 0 ? Math.min(stats.followedByRaw / stats.findOffers, 1) : null,
  };
}

export interface OpenQuestion {
  id: string;
  subject: string;
  createdAt: Date;
}

export function openQuestions(rows: Inquiry[]): OpenQuestion[] {
  return rows.map((row) => ({ id: row.id, subject: row.subject, createdAt: row.createdAt }));
}

export interface AnalyticsView {
  range: AnalyticsRange;
  since: Date;
  until: Date;
  channels: ChannelCount[];
  conversations: number;
  orders: number;
  orderValue: string[];
  inquiries: number;
  outcome: AgentOutcome;
  offers: TopOffer[];
  queries: TopQuery[];
  missedQueries: MissedQuery[];
  answers: AgentAnswers;
  days: DayPoint[];
  openQuestions: OpenQuestion[];
}

const QUERIES_SAMPLE = 200;
const OPEN_QUESTIONS = 4;
const MISSED_QUERIES = 8;

export async function loadAnalytics(
  services: Services,
  ctx: TenantContext,
  range: AnalyticsRange,
  now = new Date(),
  lang: Lang = "en",
): Promise<AnalyticsView> {
  const since = new Date(now.getTime() - range * DAY);
  const timeZone = appTimeZone();
  const [
    conversations,
    orders,
    firstMessages,
    dailyConversations,
    daily,
    unresolved,
    missedQueries,
    intentStats,
  ] = await Promise.all([
    services.conversations.stats(ctx, { since }),
    services.orders.stats(ctx, { since }),
    services.conversations.firstUserMessages(ctx, { since, limit: QUERIES_SAMPLE }),
    services.conversations.dailyCounts(ctx, { since, timeZone }),
    services.orders.dailyCounts(ctx, { since, timeZone }),
    services.orders.listInquiries(ctx, { status: "new", limit: OPEN_QUESTIONS }),
    services.catalog.searchMisses(ctx, { days: 30, limit: MISSED_QUERIES, now }),
    services.intent.stats(ctx, { days: 30, now }),
  ]);
  const placed = Object.entries(orders.byStatus).reduce(
    (sum, [status, n]) => (status === "draft" ? sum : sum + n),
    0,
  );

  return {
    range,
    since,
    until: now,
    channels: channelCounts(conversations.byChannel, lang),
    conversations: conversations.total,
    orders: placed,
    orderValue: orderValue(orders.value, lang),
    inquiries: orders.inquiries.total,
    outcome: agentOutcome(conversations, orders.inquiries),
    offers: orders.topOffers,
    queries: topQueries(firstMessages.map((m) => m.content)),
    missedQueries,
    answers: agentAnswers(intentStats),
    days: dailySeries(
      now,
      range,
      { conversations: dailyConversations, orders: daily.orders, inquiries: daily.inquiries },
      timeZone,
    ),
    openQuestions: openQuestions(unresolved),
  };
}
