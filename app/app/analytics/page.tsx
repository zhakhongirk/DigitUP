import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import {
  ANALYTICS_RANGES,
  loadAnalytics,
  parseRange,
  type DayPoint,
} from "@/server/owner/analytics";
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

function dayLabel(day: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${day}T12:00:00Z`));
}

const SERIES = [
  { key: "conversations", label: "Conversations", className: "an-s-conv" },
  { key: "orders", label: "Orders", className: "an-s-order" },
  { key: "inquiries", label: "Questions", className: "an-s-question" },
] as const;

function DailyChart({ days }: { days: DayPoint[] }) {
  const max = Math.max(1, ...days.flatMap((d) => SERIES.map((s) => d[s.key])));
  const step = days.length > 14 ? 5 : 1;
  const minWidth = Math.max(560, days.length * 34);
  return (
    <div className="an-chart-scroll">
      <div
        className="an-chart"
        style={{ minWidth }}
        role="img"
        aria-label="Conversations, orders and questions per day"
      >
        {days.map((d) => (
          <div
            key={d.day}
            className="an-day"
            title={`${dayLabel(d.day)}: ${d.conversations} conversations, ${d.orders} orders, ${d.inquiries} questions`}
          >
            {SERIES.map((series) => (
              <div
                key={series.key}
                className={`an-col ${series.className}`}
                style={{
                  height: `${(d[series.key] / max) * 100}%`,
                  minHeight: d[series.key] > 0 ? 3 : 0,
                }}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="an-axis" style={{ minWidth }}>
        {days.map((d, i) => (
          <span key={d.day}>{i % step === 0 || i === days.length - 1 ? dayLabel(d.day) : ""}</span>
        ))}
      </div>
    </div>
  );
}

interface BarItem {
  key: string;
  label: string;
  value: string;
  share: number;
}

function Bars({ items }: { items: BarItem[] }) {
  return items.map((item) => (
    <div key={item.key} className="an-bar-row">
      <div className="an-bar-label">
        <span className="an-text">{item.label}</span>
        <span className="an-num">{item.value}</span>
      </div>
      <div className="an-track">
        <div className="an-fill" style={{ width: `${item.share * 100}%` }} />
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
  const maxQuery = Math.max(1, ...view.queries.map((q) => q.count));
  const hasActivity = view.days.some((d) => d.conversations + d.orders + d.inquiries > 0);

  return (
    <>
      <div className="ws-title">
        <div className="an-heading">
          <h1>Analytics</h1>
          <span className="an-period">
            Last {range} days · {period(view.since, view.until)}
          </span>
        </div>
        <div className="an-actions">
          <div className="segmented segmented-sm" role="group" aria-label="Period">
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
          <a
            className="btn btn-sm btn-secondary"
            href={`/app/export/orders?range=${range}`}
            download
          >
            Export orders (CSV)
          </a>
        </div>
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

      <section className="an-card an-wide glass" aria-labelledby="an-daily">
        <div className="an-card-head">
          <h2 id="an-daily">Activity by day</h2>
          <div className="an-legend">
            {SERIES.map((series) => (
              <span key={series.key}>
                <i className={series.className} />
                {series.label}
              </span>
            ))}
          </div>
        </div>
        {hasActivity ? (
          <DailyChart days={view.days} />
        ) : (
          <p className="an-empty">No activity in this period.</p>
        )}
      </section>

      <div className="an-row">
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

        <section className="an-card an-list glass" aria-labelledby="an-offers">
          <h2 id="an-offers">Top offers</h2>
          {view.offers.length === 0 ? (
            <p className="an-empty">No orders in this period.</p>
          ) : (
            <>
              <div className="an-list-head">
                <span>Offer</span>
                <span>Ordered</span>
              </div>
              {view.offers.map((o) => (
                <div key={o.offerId} className="an-list-row">
                  <span className="an-text">{o.title}</span>
                  <span className="an-num">{o.quantity}</span>
                </div>
              ))}
            </>
          )}
        </section>
      </div>

      <div className="an-row">
        <section className="an-card an-list glass" aria-labelledby="an-open">
          <div className="an-card-head">
            <h2 id="an-open">Unanswered questions</h2>
            {outcome.unresolved > 0 ? <span className="an-count">{outcome.unresolved}</span> : null}
          </div>
          {view.openQuestions.length === 0 ? (
            <p className="an-empty">Nothing is waiting for your answer.</p>
          ) : (
            view.openQuestions.map((q) => (
              <div key={q.id} className="an-list-row">
                <span className="an-q">
                  <span className="an-text">{q.subject}</span>
                  <span className="an-q-meta">Asked {formatDay(q.createdAt)}</span>
                </span>
                <Link className="an-answer" href={`/app/inbox?filter=new&item=inquiry:${q.id}`}>
                  Answer
                </Link>
              </div>
            ))
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
    </>
  );
}
