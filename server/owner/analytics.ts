import type { Services } from "@/server/container";
import type { TenantContext } from "@/server/services/context";
import type { Conversation, ConversationStats } from "@/server/services/conversations";
import type { OrderStats } from "@/server/services/orders";
import { formatPrice } from "@/shared/format";

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

export function channelCounts(byChannel: ConversationStats["byChannel"]): ChannelCount[] {
  return (["storefront", "external_agent"] as const).map((channel) => ({
    channel,
    label: CHANNEL_LABELS[channel],
    count: byChannel[channel],
  }));
}

export function orderValue(value: OrderStats["value"]): string[] {
  return value.map(({ currency, total }) => formatPrice(total, currency));
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
}

const QUERIES_SAMPLE = 200;

export async function loadAnalytics(
  services: Services,
  ctx: TenantContext,
  range: AnalyticsRange,
  now = new Date(),
): Promise<AnalyticsView> {
  const since = new Date(now.getTime() - range * DAY);
  const [conversations, orders, firstMessages] = await Promise.all([
    services.conversations.stats(ctx, { since }),
    services.orders.stats(ctx, { since }),
    services.conversations.firstUserMessages(ctx, { since, limit: QUERIES_SAMPLE }),
  ]);
  const placed = Object.entries(orders.byStatus).reduce(
    (sum, [status, n]) => (status === "draft" ? sum : sum + n),
    0,
  );

  return {
    range,
    since,
    until: now,
    channels: channelCounts(conversations.byChannel),
    conversations: conversations.total,
    orders: placed,
    orderValue: orderValue(orders.value),
    inquiries: orders.inquiries.total,
    outcome: agentOutcome(conversations, orders.inquiries),
    offers: orders.topOffers,
    queries: topQueries(firstMessages.map((m) => m.content)),
  };
}
