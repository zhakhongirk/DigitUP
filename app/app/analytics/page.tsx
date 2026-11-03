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
import { ownerMeta, ownerT } from "@/server/owner/lang";
import { currentOwner } from "@/server/owner/session";
import { formatDay } from "@/server/time";
import { LOCALES, type Lang, type Translator } from "@/shared/owner-copy";
import "./analytics.css";

export const generateMetadata = (): Promise<Metadata> => ownerMeta("nav.analytics");

function percent(share: number | null, t: Translator["t"]): string {
  return share === null ? t("an.noData") : `${Math.round(share * 100)}%`;
}

function dayLabel(day: string, lang: Lang): string {
  return new Intl.DateTimeFormat(LOCALES[lang], {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${day}T12:00:00Z`));
}

const SERIES = [
  { key: "conversations", label: "an.conversations", className: "an-s-conv" },
  { key: "orders", label: "an.orders", className: "an-s-order" },
  { key: "inquiries", label: "an.questions", className: "an-s-question" },
] as const;

function DailyChart({ days, tr }: { days: DayPoint[]; tr: Translator }) {
  const { t, lang } = tr;
  const max = Math.max(1, ...days.flatMap((d) => SERIES.map((s) => d[s.key])));
  const step = days.length > 14 ? 5 : 1;
  const minWidth = Math.max(560, days.length * 34);
  return (
    <div className="an-chart-scroll">
      <div className="an-chart" style={{ minWidth }} role="img" aria-label={t("an.chartLabel")}>
        {days.map((d) => (
          <div
            key={d.day}
            className="an-day"
            title={t("an.dayTitle", {
              day: dayLabel(d.day, lang),
              conversations: d.conversations,
              orders: d.orders,
              inquiries: d.inquiries,
            })}
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
          <span key={d.day}>
            {i % step === 0 || i === days.length - 1 ? dayLabel(d.day, lang) : ""}
          </span>
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
  const [tr, owner] = await Promise.all([ownerT(), currentOwner(services)]);
  if (!owner) redirect("/signin?next=/app/analytics");
  const { t, lang } = tr;

  const view = await loadAnalytics(services, owner, range, undefined, lang);
  const { outcome } = view;
  const maxQuery = Math.max(1, ...view.queries.map((q) => q.count));
  const maxMissed = Math.max(1, ...view.missedQueries.map((q) => q.count));
  const hasActivity = view.days.some((d) => d.conversations + d.orders + d.inquiries > 0);

  return (
    <>
      <div className="ws-title">
        <div className="an-heading">
          <h1>{t("nav.analytics")}</h1>
          <span className="an-period">
            {t("an.period", {
              range,
              from: formatDay(view.since, undefined, lang),
              to: formatDay(view.until, undefined, lang),
            })}
          </span>
        </div>
        <div className="an-actions">
          <div className="segmented segmented-sm" role="group" aria-label={t("an.periodLabel")}>
            {ANALYTICS_RANGES.map((r) => (
              <Link
                key={r}
                href={`/app/analytics?range=${r}`}
                aria-current={r === range ? "page" : undefined}
              >
                {t("an.days", { n: r })}
              </Link>
            ))}
          </div>
          <a
            className="btn btn-sm btn-secondary"
            href={`/app/export/orders?range=${range}`}
            download
          >
            {t("an.exportOrders")}
          </a>
        </div>
      </div>

      <div className="an-kpis">
        <div className="an-kpi glass">
          <span className="an-kpi-label">{t("an.conversations")}</span>
          <span className="an-kpi-value">{view.conversations}</span>
          <span className="an-kpi-note">{t("an.withAssistant")}</span>
        </div>
        <div className="an-kpi glass">
          <span className="an-kpi-label">{t("an.orders")}</span>
          <span className="an-kpi-value">{view.orders}</span>
          <span className="an-kpi-note">
            {view.orderValue.length > 0 ? view.orderValue.join(" + ") : t("an.noOrders")}
          </span>
        </div>
        <div className="an-kpi glass">
          <span className="an-kpi-label">{t("an.questions")}</span>
          <span className="an-kpi-value">{view.inquiries}</span>
          <span className="an-kpi-note">{t("an.handedOver")}</span>
        </div>
        <div className="an-kpi glass">
          <span className="an-kpi-label">{t("an.unanswered")}</span>
          <span className="an-kpi-value">{outcome.unresolved}</span>
          <span className={outcome.unresolved > 0 ? "an-kpi-note an-warn" : "an-kpi-note"}>
            {t(outcome.unresolved > 0 ? "an.needAnswer" : "an.caughtUp")}
          </span>
        </div>
      </div>

      <section className="an-card an-wide glass" aria-labelledby="an-daily">
        <div className="an-card-head">
          <h2 id="an-daily">{t("an.daily")}</h2>
          <div className="an-legend">
            {SERIES.map((series) => (
              <span key={series.key}>
                <i className={series.className} />
                {t(series.label)}
              </span>
            ))}
          </div>
        </div>
        {hasActivity ? (
          <DailyChart days={view.days} tr={tr} />
        ) : (
          <p className="an-empty">{t("an.noActivity")}</p>
        )}
      </section>

      <div className="an-row">
        <section className="an-card glass" aria-labelledby="an-queries">
          <h2 id="an-queries">{t("an.firstAsk")}</h2>
          {view.queries.length === 0 ? (
            <p className="an-empty">{t("an.noQueries")}</p>
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
          <h2 id="an-offers">{t("an.topOffers")}</h2>
          {view.offers.length === 0 ? (
            <p className="an-empty">{t("an.noOrdersPeriod")}</p>
          ) : (
            <>
              <div className="an-list-head">
                <span>{t("an.colOffer")}</span>
                <span>{t("an.colOrdered")}</span>
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

      <section className="an-card an-wide glass" aria-labelledby="an-missed">
        <h2 id="an-missed">{t("an.missed")}</h2>
        <p className="an-q-meta">{t("an.missedNote")}</p>
        {view.missedQueries.length === 0 ? (
          <p className="an-empty">{t("an.noMissed")}</p>
        ) : (
          <Bars
            items={view.missedQueries.map((q) => ({
              key: q.query,
              label: q.query,
              value: String(q.count),
              share: q.count / maxMissed,
            }))}
          />
        )}
      </section>

      <div className="an-row">
        <section className="an-card an-list glass" aria-labelledby="an-open">
          <div className="an-card-head">
            <h2 id="an-open">{t("an.unansweredQuestions")}</h2>
            {outcome.unresolved > 0 ? <span className="an-count">{outcome.unresolved}</span> : null}
          </div>
          {view.openQuestions.length === 0 ? (
            <p className="an-empty">{t("an.nothingWaiting")}</p>
          ) : (
            view.openQuestions.map((q) => (
              <div key={q.id} className="an-list-row">
                <span className="an-q">
                  <span className="an-text">{q.subject}</span>
                  <span className="an-q-meta">
                    {t("an.asked", { day: formatDay(q.createdAt, undefined, lang) })}
                  </span>
                </span>
                <Link className="an-answer" href={`/app/inbox?filter=new&item=inquiry:${q.id}`}>
                  {t("an.answer")}
                </Link>
              </div>
            ))
          )}
        </section>

        <section className="an-card glass" aria-labelledby="an-agent">
          <h2 id="an-agent">{t("an.howDid")}</h2>
          <dl className="an-facts">
            <div>
              <dt>{t("an.endedIn")}</dt>
              <dd>{percent(outcome.resolvedShare, t)}</dd>
            </div>
            <div>
              <dt>{t("an.withOrder")}</dt>
              <dd>{outcome.toOrder}</dd>
            </div>
            <div>
              <dt>{t("an.withQuestion")}</dt>
              <dd>{outcome.toInquiry}</dd>
            </div>
            <div>
              <dt>{t("an.stillNew")}</dt>
              <dd>{outcome.unresolved}</dd>
            </div>
          </dl>
          {outcome.unresolved > 0 ? (
            <Link className="an-link" href="/app/inbox?filter=new">
              {t("an.openInbox")}
            </Link>
          ) : null}
        </section>
      </div>
    </>
  );
}
