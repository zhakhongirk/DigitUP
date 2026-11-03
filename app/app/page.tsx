import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { CopyButton } from "@/app/onboarding/done/copy-button";
import { appBaseUrl } from "@/server/owner/base-url";
import { actorLabel } from "@/server/owner/audit";
import { formatWhen } from "@/server/owner/inbox";
import { ownerMeta, ownerT } from "@/server/owner/lang";
import { currentOwner } from "@/server/owner/session";
import {
  changeHref,
  feedSummary,
  inboxBreakdown,
  inboxHref,
  loadWorkspace,
} from "@/server/owner/workspace";
import "./workspace.css";

export const generateMetadata = (): Promise<Metadata> => ownerMeta("nav.workspace");

export default async function WorkspacePage() {
  const services = await getServices();
  const [{ lang, t, tn }, owner] = await Promise.all([ownerT(), currentOwner(services)]);
  if (!owner) redirect("/signin?next=/app");

  const [view, base, unread] = await Promise.all([
    loadWorkspace(services, owner, lang),
    appBaseUrl(),
    services.notifications.unreadCount(owner),
  ]);
  const now = new Date();
  const newCount = view.newOrders + view.newInquiries;
  const nothingWaiting = newCount === 0 && view.pendingCount === 0;
  const { health } = view;
  const setupLeft = view.setup.filter((item) => !item.done).length;
  const setupTotal = view.setup.length;
  const newest = [
    ...view.pending.map((c) => c.createdAt),
    ...view.newItems.map((i) => i.at),
    ...view.activity.map((a) => a.at),
  ].sort((a, b) => b.getTime() - a.getTime())[0];

  return (
    <>
      <h1 className="sr-only">{t("ws.title")}</h1>
      <div className="wk-layout">
        <section className="wk-feed glass-strong" aria-labelledby="wk-feed-title">
          <header className="wk-feed-head">
            <span className="wk-feed-avatar" aria-hidden="true">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
              >
                <path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z" />
              </svg>
            </span>
            <div className="wk-feed-title">
              <b id="wk-feed-title">{t("ws.activity")}</b>
              <span>{t("ws.activitySub")}</span>
            </div>
            <Link href="/app/notifications" className="wk-feed-link">
              {unread > 0 ? t("ws.notificationsNew", { n: unread }) : t("ws.notifications")}
            </Link>
          </header>

          <div className="wk-feed-body">
            {newest ? (
              <span className="sys-line">{formatWhen(newest, now, undefined, lang)}</span>
            ) : null}
            <p className="wk-bubble">{feedSummary(view, lang)}</p>

            {view.pending.map((change) => (
              <Link key={change.id} href={changeHref(change.id)} className="wk-card-item">
                <span className="wk-card-row">
                  <b>{t("ws.approval", { summary: change.summary })}</b>
                  <span className="wk-chip wk-chip-warn">{t("ws.pending")}</span>
                </span>
                <span className="wk-card-text">
                  {t("ws.requested", { when: formatWhen(change.createdAt, now, undefined, lang) })}
                </span>
                <span className="wk-card-cta">{t("ws.reviewChanges")}</span>
              </Link>
            ))}
            {view.pendingCount > view.pending.length ? (
              <Link href="/app/approvals" className="wk-more">
                {t("ws.seeAllApprovals", { n: view.pendingCount })}
              </Link>
            ) : null}

            {view.newItems.map((item) => (
              <Link key={item.key} href={inboxHref(item)} className="wk-card-item">
                <span className="wk-card-row">
                  <b>
                    {item.label} · {item.who}
                  </b>
                  <span className="wk-chip wk-chip-info">{t("ws.new")}</span>
                </span>
                <span className="wk-card-text wk-clip">{item.preview}</span>
                <span className="wk-card-cta">{t("ws.openInInbox")}</span>
              </Link>
            ))}
            {newCount > view.newItems.length ? (
              <Link href="/app/inbox?filter=new" className="wk-more">
                {t("ws.seeAllInbox", { n: newCount })}
              </Link>
            ) : null}

            {setupLeft > 0 ? (
              <>
                <p className="wk-bubble">
                  {t("ws.finishSetup", { done: setupTotal - setupLeft, total: setupTotal })}
                </p>
                <ol className="wk-list wk-setup">
                  {view.setup.map((item) => (
                    <li key={item.key} className={item.done ? "wk-done" : undefined}>
                      <Link
                        href={item.href}
                        className="wk-step"
                        {...(item.external ? { target: "_blank", rel: "noreferrer" } : {})}
                      >
                        <span className="wk-check" aria-hidden="true">
                          {item.done ? "✓" : ""}
                        </span>
                        <span>
                          <b>
                            {item.title}
                            <span className="sr-only">
                              {t(item.done ? "ws.stepDone" : "ws.stepTodo")}
                            </span>
                          </b>
                          <small>{item.hint}</small>
                        </span>
                      </Link>
                      {item.copy ? <CopyButton text={`${base}${item.copy}`} /> : null}
                    </li>
                  ))}
                </ol>
              </>
            ) : null}

            {view.activity.length > 0 ? (
              <>
                <p className="wk-bubble">{t("ws.latest")}</p>
                <div className="wk-list wk-changes">
                  <ul>
                    {view.activity.map((row) => (
                      <li key={row.id}>
                        <span className="wk-tick" aria-hidden="true">
                          ✓
                        </span>
                        <span className="wk-change-text">
                          {actorLabel(row.actor, lang)}: {row.what}
                          {row.change ? ` ${row.change}` : ""}
                        </span>
                        <time dateTime={row.at.toISOString()}>
                          {formatWhen(row.at, now, undefined, lang)}
                        </time>
                      </li>
                    ))}
                  </ul>
                  <Link href="/app/audit" className="wk-more">
                    {t("ws.seeAudit")}
                  </Link>
                </div>
              </>
            ) : null}
          </div>

          <div className="wk-suggest">
            {view.pendingCount > 0 ? (
              <Link href="/app/approvals" className="suggestion">
                {t("ws.sugApprovals")}
              </Link>
            ) : null}
            {view.newInquiries > 0 ? (
              <Link href="/app/inbox?filter=new" className="suggestion">
                {t("ws.sugQuestions")}
              </Link>
            ) : null}
            {health.priceOnRequest > 0 ? (
              <Link href="/app/catalog" className="suggestion">
                {t("ws.sugPrices")}
              </Link>
            ) : null}
            <Link href="/app/agents" className="suggestion">
              {t("ws.sugAgent")}
            </Link>
          </div>

          <Link href="/app/catalog/import" className="composer wk-composer">
            <span className="wk-composer-btn wk-composer-plus" aria-hidden="true">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </span>
            <span className="wk-composer-text">{t("ws.composer")}</span>
            <span className="wk-composer-btn wk-composer-go" aria-hidden="true">
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </span>
          </Link>
        </section>

        <aside className="wk-aside">
          <section className="wk-side glass" aria-labelledby="wk-health">
            <b id="wk-health">{t("ws.health")}</b>
            <dl className="wk-rows">
              <div>
                <dt>{t("ws.activeOffers")}</dt>
                <dd>{health.active}</dd>
              </div>
              <div>
                <dt>{t("ws.priceOnRequest")}</dt>
                <dd className={health.priceOnRequest > 0 ? "wk-warn" : undefined}>
                  {health.priceOnRequest}
                </dd>
              </div>
              <div>
                <dt>{t("ws.stockUnknown")}</dt>
                <dd className={health.stockUnknown > 0 ? "wk-warn" : undefined}>
                  {health.stockUnknown}
                </dd>
              </div>
              <div>
                <dt>{t("ws.openQuestions")}</dt>
                <dd className={view.newInquiries > 0 ? "wk-warn" : undefined}>
                  {view.newInquiries}
                </dd>
              </div>
            </dl>
          </section>

          <section className="wk-side glass" aria-labelledby="wk-needs">
            <b id="wk-needs">{t("ws.needsYou")}</b>
            {nothingWaiting ? (
              <p className="wk-empty">{t("ws.nothingWaiting")}</p>
            ) : (
              <>
                {view.pendingCount > 0 ? (
                  <Link href="/app/approvals" className="wk-tile wk-tile-warn">
                    <b>
                      {tn("n.approval", view.pendingCount)}
                      {view.pending[0] ? ` · ${view.pending[0].summary}` : ""}
                    </b>
                    <span>{t("ws.awaitingApproval")}</span>
                  </Link>
                ) : null}
                {newCount > 0 ? (
                  <Link href="/app/inbox?filter=new" className="wk-tile wk-tile-info">
                    <b>{t("ws.newInInbox", { n: newCount })}</b>
                    <span>{inboxBreakdown(view.newOrders, view.newInquiries, lang)}</span>
                  </Link>
                ) : null}
              </>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}
