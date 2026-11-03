import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { CopyButton } from "@/app/onboarding/done/copy-button";
import { appBaseUrl } from "@/server/owner/base-url";
import { ACTOR_LABELS } from "@/server/owner/audit";
import { formatWhen } from "@/server/owner/inbox";
import { currentOwner } from "@/server/owner/session";
import {
  changeHref,
  inboxBreakdown,
  inboxHref,
  loadWorkspace,
  plural,
} from "@/server/owner/workspace";
import "./workspace.css";

export const metadata: Metadata = { title: "Workspace" };

export default async function WorkspacePage() {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app");

  const [view, base] = await Promise.all([loadWorkspace(services, owner), appBaseUrl()]);
  const now = new Date();
  const newCount = view.newOrders + view.newInquiries;
  const nothingWaiting = newCount === 0 && view.pendingCount === 0;
  const { health } = view;
  const setupLeft = view.setup.filter((item) => !item.done).length;
  const showSetup = nothingWaiting && setupLeft > 0;

  return (
    <>
      <div className="ws-title">
        <h1>Workspace</h1>
        <p className="ws-sub">What needs you today and how the store looks.</p>
      </div>

      <div className="wk-grid">
        <section className="wk-card glass" aria-labelledby="wk-needs">
          <h2 id="wk-needs">{showSetup ? "Get your store ready" : "Needs you"}</h2>
          {showSetup ? (
            <ol className="wk-setup">
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
                        <span className="sr-only">{item.done ? " (done)" : " (to do)"}</span>
                      </b>
                      <small>{item.hint}</small>
                    </span>
                  </Link>
                  {item.copy ? <CopyButton text={`${base}${item.copy}`} /> : null}
                </li>
              ))}
            </ol>
          ) : nothingWaiting ? (
            <p className="wk-empty">You are all caught up.</p>
          ) : (
            <div className="wk-stack">
              {view.pendingCount > 0 ? (
                <div className="wk-group wk-group-warn">
                  <Link href="/app/changes" className="wk-head">
                    <b>{plural(view.pendingCount, "change set")} to review</b>
                    <span>Awaiting your approval</span>
                  </Link>
                  <ul>
                    {view.pending.map((change) => (
                      <li key={change.id}>
                        <Link href={changeHref(change.id)}>
                          <span>{change.summary}</span>
                          <time dateTime={change.createdAt.toISOString()}>
                            {formatWhen(change.createdAt, now)}
                          </time>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {newCount > 0 ? (
                <div className="wk-group wk-group-info">
                  <Link href="/app/inbox?filter=new" className="wk-head">
                    <b>{newCount} new in inbox</b>
                    <span>{inboxBreakdown(view.newOrders, view.newInquiries)}</span>
                  </Link>
                  <ul>
                    {view.newItems.map((item) => (
                      <li key={item.key}>
                        <Link href={inboxHref(item)}>
                          <span>
                            <span>
                              <b>{item.label}</b> · {item.who}
                            </span>
                            <span className="wk-preview">{item.preview}</span>
                          </span>
                          <time dateTime={item.at.toISOString()}>{formatWhen(item.at, now)}</time>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          )}
        </section>

        <section className="wk-card glass" aria-labelledby="wk-health">
          <h2 id="wk-health">Catalog health</h2>
          <dl className="wk-rows">
            <div>
              <dt>Active offers</dt>
              <dd>{health.active}</dd>
            </div>
            <div>
              <dt>Price on request</dt>
              <dd className={health.priceOnRequest > 0 ? "wk-warn" : undefined}>
                {health.priceOnRequest}
              </dd>
            </div>
            <div>
              <dt>Stock unknown</dt>
              <dd className={health.stockUnknown > 0 ? "wk-warn" : undefined}>
                {health.stockUnknown}
              </dd>
            </div>
          </dl>
        </section>
      </div>

      <section className="wk-card glass" aria-labelledby="wk-activity">
        <div className="wk-card-head">
          <h2 id="wk-activity">Recent activity</h2>
          <Link href="/app/audit">See in audit log</Link>
        </div>
        {view.activity.length === 0 ? (
          <p className="wk-empty">No changes recorded yet.</p>
        ) : (
          <ol className="wk-activity">
            {view.activity.map((row) => (
              <li key={row.id}>
                <span className={`au-actor au-actor-${row.actor}`}>{ACTOR_LABELS[row.actor]}</span>
                <span className="au-what">
                  {row.what}
                  {row.change ? <span className="au-change">{row.change}</span> : null}
                </span>
                <time dateTime={row.at.toISOString()} className="au-when">
                  {formatWhen(row.at, now)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
