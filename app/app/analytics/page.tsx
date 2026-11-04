import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getServices } from "@/server/container";
import { formatWhen } from "@/server/owner/inbox";
import { loadModelCalls, type CallPath } from "@/server/owner/model-calls";
import {
  ANALYTICS_RANGES,
  loadAnalytics,
  parseRange,
  type DayPoint,
} from "@/server/owner/analytics";
import { ownerMeta, ownerT } from "@/server/owner/lang";
import { ownerOnly } from "@/server/owner/access";
import { currentOwner } from "@/server/owner/session";
import { formatDay } from "@/server/time";
import { LOCALES, type Lang, type Translator } from "@/shared/owner-copy";
import { Dismiss, LinkTargets, LinkTerm, Unlink } from "./link-products";
import "./analytics.css";

export const generateMetadata = (): Promise<Metadata> => ownerMeta("nav.analytics");

function percent(share: number | null, t: Translator["t"]): string {
  return share === null ? t("an.noData") : `${Math.round(share * 100)}%`;
}

const PATH_LABEL = {
  loop: "an.pathLoop",
  fast_path: "an.pathFast_path",
  rewrite: "an.pathRewrite",
  fallback: "an.pathFallback",
} as const satisfies Record<CallPath, string>;

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
  ownerOnly(owner);
  const { t, lang } = tr;

  const now = new Date();
  const [view, calls] = await Promise.all([
    loadAnalytics(services, owner, range, now, lang),
    loadModelCalls(getDb(), owner, new Date(now.getTime() - range * 24 * 3600 * 1000)),
  ]);
  const { outcome } = view;
  const maxQuery = Math.max(1, ...view.queries.map((q) => q.count));
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
        <LinkTargets targets={view.targets}>
          {view.missedQueries.length === 0 ? (
            <p className="an-empty">{t("an.noMissed")}</p>
          ) : (
            view.missedQueries.map((q) => (
              <div key={q.query} className="an-miss-row">
                <span className="an-miss-main">
                  <span className="an-text">{q.query}</span>
                  <span className="an-q-meta">{q.count}</span>
                </span>
                <span className="an-miss-tools">
                  <LinkTerm term={q.query} />
                </span>
              </div>
            ))
          )}
          {view.linked.length > 0 ? (
            <>
              <h3 className="an-sub">{t("an.linkedTitle")}</h3>
              <p className="an-q-meta">{t("an.linkedNote")}</p>
              {view.linked.map((link) => (
                <div key={link.term} className="an-miss-row">
                  <span className="an-miss-main">
                    <span className="an-text">{link.term}</span>
                    <span className="an-q-meta">{link.titles.join(", ")}</span>
                  </span>
                  <span className="an-miss-tools">
                    <Unlink term={link.term} />
                  </span>
                </div>
              ))}
            </>
          ) : null}
        </LinkTargets>
      </section>

      <section className="an-card an-wide glass" aria-labelledby="an-answers">
        <h2 id="an-answers">{t("an.answers")}</h2>
        <p className="an-q-meta">{t("an.answersNote")}</p>
        {view.answers.findOffers === 0 ? (
          <p className="an-empty">{t("an.answersNone")}</p>
        ) : (
          <dl className="an-facts">
            <div>
              <dt>{t("an.answersCount")}</dt>
              <dd>{view.answers.findOffers}</dd>
            </div>
            <div>
              <dt>
                {t("an.answersFlagged")}
                <span className="an-q-meta">
                  {" "}
                  {t("an.answersFlaggedNote", { rated: view.answers.rated })}
                </span>
              </dt>
              <dd>{percent(view.answers.flaggedShare, t)}</dd>
            </div>
            <div>
              <dt>
                {t("an.answersRaw")}
                <span className="an-q-meta"> {t("an.answersRawNote")}</span>
              </dt>
              <dd>{percent(view.answers.rawShare, t)}</dd>
            </div>
          </dl>
        )}
        <h3 className="an-sub">{t("an.review")}</h3>
        <p className="an-q-meta">{t("an.reviewNote")}</p>
        {view.review.length === 0 ? (
          <p className="an-empty">{t("an.reviewNone")}</p>
        ) : (
          <LinkTargets targets={view.targets}>
            {view.review.map((report) => (
              <div key={report.id} className="an-miss-row">
                <span className="an-miss-main">
                  <span className="an-text">{report.query}</span>
                  <span className="an-q-meta">
                    {report.returned.length > 0
                      ? t("an.reviewReturned", { titles: report.returned.join(", ") })
                      : t("an.reviewNothing")}
                  </span>
                  {report.comment ? (
                    <span className="an-q-meta">
                      {t("an.reviewComment", { comment: report.comment })}
                    </span>
                  ) : null}
                  <span className="an-q-meta">
                    {formatWhen(report.createdAt, now, undefined, lang)}
                  </span>
                </span>
                <span className="an-miss-tools">
                  <LinkTerm term={report.query} reviewId={report.id} />
                  <Dismiss id={report.id} />
                </span>
              </div>
            ))}
          </LinkTargets>
        )}
      </section>

      <section className="an-card an-wide an-list glass" aria-labelledby="an-calls">
        <h2 id="an-calls">{t("an.calls")}</h2>
        <p className="an-q-meta">{t("an.callsNote")}</p>
        {calls.total === 0 ? (
          <p className="an-empty">{t("an.callsNone")}</p>
        ) : (
          <>
            <p className="an-calls-summary">
              {calls.averageMs === null
                ? t("an.callsSummaryNoMs", { n: calls.total })
                : t("an.callsSummary", { n: calls.total, ms: calls.averageMs })}
            </p>
            <div className="an-legend an-calls-paths">
              {calls.byPath
                .filter((p) => p.count > 0)
                .map((p) => (
                  <span key={p.path}>
                    <i className={`an-path an-path-${p.path}`} />
                    {t(PATH_LABEL[p.path])}: {p.count}
                  </span>
                ))}
            </div>
            <div className="an-calls-scroll">
              <div className="an-call an-list-head">
                <span>{t("an.colWhen")}</span>
                <span>{t("an.colTier")}</span>
                <span>{t("an.colModel")}</span>
                <span className="an-num">{t("an.colMs")}</span>
                <span className="an-num">{t("an.colTokens")}</span>
                <span>{t("an.colPath")}</span>
              </div>
              {calls.recent.map((call) => (
                <div key={call.id} className="an-call an-list-row">
                  <span>{formatWhen(call.at, now, undefined, lang)}</span>
                  <span>{call.tier}</span>
                  <span className="an-text">{call.model}</span>
                  <span className="an-num">
                    {call.ms === null ? t("an.noData") : t("an.ms", { ms: call.ms })}
                  </span>
                  <span className="an-num">{call.inputTokens + call.outputTokens}</span>
                  <span>
                    <i className={`an-path an-path-${call.path}`} /> {t(PATH_LABEL[call.path])}
                  </span>
                </div>
              ))}
            </div>
          </>
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
