import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { ANALYTICS_RANGES, loadAnalytics, parseRange } from "@/server/owner/analytics";
import { currentOwner } from "@/server/owner/session";
import { formatDay } from "@/server/time";
import "./analytics.css";

export const metadata: Metadata = { title: "Analytics" };

function percent(share: number | null): string {
  return share === null ? "No data" : `${Math.round(share * 100)}%`;
}

function period(since: Date, until: Date): string {
  return `${formatDay(since)} to ${formatDay(until)}`;
}

interface BarItem {
  key: string;
  label: string;
  value: string;
  share: number;
  tone?: string;
}

function Bars({ items }: { items: BarItem[] }) {
  return items.map((item) => (
    <div key={item.key} className="an-bar-row">
      <div className="an-bar-label">
        <span className="an-text">{item.label}</span>
        <span className="an-num">{item.value}</span>
      </div>
      <div className="an-track">
        <div className={`an-fill ${item.tone ?? ""}`} style={{ width: `${item.share * 100}%` }} />
      </div>
    </div>
  ));
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const range = parseRange(params.range);

  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/analytics");

  const view = await loadAnalytics(services, owner, range);
  const { outcome } = view;
  const maxChannel = Math.max(1, ...view.channels.map((c) => c.count));
  const maxOffer = Math.max(1, ...view.offers.map((o) => o.quantity));
  const maxQuery = Math.max(1, ...view.queries.map((q) => q.count));

  return (
    <>
      <div className="ws-title">
        <div className="an-heading">
          <h1>Analytics</h1>
          <span className="an-period">
            Last {range} days · {period(view.since, view.until)}
          </span>
        </div>
        <div className="segmented" role="group" aria-label="Period">
          {ANALYTICS_RANGES.map((r) => (
            <Link
              key={r}
              href={`/app/analytics?range=${r}`}
              aria-current={r === range ? "page" : undefined}
            >
              {r} days
            </Link>
          ))}
        </div>
        <a className="an-link" href={`/app/export/orders?range=${range}`} download>
          Export orders (CSV)
        </a>
      </div>

      <div className="an-kpis">
        <div className="an-kpi glass">
          <span className="an-kpi-label">Conversations</span>
          <span className="an-kpi-value">{view.conversations}</span>
          <span className="an-kpi-note">With the store assistant</span>
        </div>
        <div className="an-kpi glass">
          <span className="an-kpi-label">Orders</span>
          <span className="an-kpi-value">{view.orders}</span>
          <span className="an-kpi-note">
            {view.orderValue.length > 0 ? view.orderValue.join(" + ") : "No orders yet"}
          </span>
        </div>
        <div className="an-kpi glass">
          <span className="an-kpi-label">Questions</span>
          <span className="an-kpi-value">{view.inquiries}</span>
          <span className="an-kpi-note">Handed over to you</span>
        </div>
        <div className="an-kpi glass">
          <span className="an-kpi-label">Unanswered</span>
          <span className="an-kpi-value">{outcome.unresolved}</span>
          <span className={outcome.unresolved > 0 ? "an-kpi-note an-warn" : "an-kpi-note"}>
            {outcome.unresolved > 0 ? "Need your answer" : "All caught up"}
          </span>
        </div>
      </div>

      <div className="an-row">
        <section className="an-card glass" aria-labelledby="an-channels">
          <h2 id="an-channels">Conversations by channel</h2>
          {view.conversations === 0 ? (
            <p className="an-empty">No conversations in this period.</p>
          ) : (
            <Bars
              items={view.channels.map((c) => ({
                key: c.channel,
                label: c.label,
                value: String(c.count),
                share: c.count / maxChannel,
                tone: c.channel === "external_agent" ? "an-fill-external" : undefined,
              }))}
            />
          )}
        </section>

        <section className="an-card glass" aria-labelledby="an-agent">
          <h2 id="an-agent">How the store assistant did</h2>
          <dl className="an-facts">
            <div>
              <dt>Ended in an order or a question</dt>
              <dd>{percent(outcome.resolvedShare)}</dd>
            </div>
            <div>
              <dt>Conversations with an order</dt>
              <dd>{outcome.toOrder}</dd>
            </div>
            <div>
              <dt>Conversations with a question</dt>
              <dd>{outcome.toInquiry}</dd>
            </div>
            <div>
              <dt>Questions still new</dt>
              <dd>{outcome.unresolved}</dd>
            </div>
          </dl>
          {outcome.unresolved > 0 ? (
            <Link className="an-link" href="/app/inbox?filter=new">
              Open the inbox
            </Link>
          ) : null}
        </section>
      </div>

      <div className="an-row">
        <section className="an-card glass" aria-labelledby="an-offers">
          <h2 id="an-offers">Top offers</h2>
          {view.offers.length === 0 ? (
            <p className="an-empty">No orders in this period.</p>
          ) : (
            <Bars
              items={view.offers.map((o) => ({
                key: o.offerId,
                label: o.title,
                value: `${o.quantity} ordered`,
                share: o.quantity / maxOffer,
              }))}
            />
          )}
        </section>

        <section className="an-card glass" aria-labelledby="an-queries">
          <h2 id="an-queries">What shoppers ask first</h2>
          {view.queries.length === 0 ? (
            <p className="an-empty">No shopper questions in this period.</p>
          ) : (
            <Bars
              items={view.queries.map((q) => ({
                key: q.text,
                label: q.text,
                value: String(q.count),
                share: q.count / maxQuery,
              }))}
            />
          )}
        </section>
      </div>
    </>
  );
}
