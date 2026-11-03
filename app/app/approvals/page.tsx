import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { CHANGE_STATUS_LABELS, loadChanges, type ChangeSetView } from "@/server/owner/changes";
import { formatWhen } from "@/server/owner/inbox";
import { currentOwner } from "@/server/owner/session";
import { DecisionButtons } from "./decision-buttons";

export const metadata: Metadata = { title: "Approvals" };

function Banner({ view }: { view: ChangeSetView }) {
  if (view.status === "applied") {
    return (
      <div className="cs-banner cs-banner-ok">
        <b>Applied</b>
        <span>These changes are live on the storefront and the agent endpoints.</span>
      </div>
    );
  }
  if (view.status === "rejected") {
    return (
      <div className="cs-banner cs-banner-bad">
        <b>Rejected</b>
        <span>Nothing in the catalog changed.</span>
      </div>
    );
  }
  if (view.flagged.length === 0) return null;
  const n = view.flagged.length;
  return (
    <div className="cs-banner cs-banner-warn">
      <b>
        {n} {n === 1 ? "price moves" : "prices move"} by more than 10%
      </b>
      <span>{view.flagged.join(", ")}. Check against the supplier file before approving.</span>
    </div>
  );
}

function Detail({ view, now }: { view: ChangeSetView; now: Date }) {
  const pending = view.status === "pending";
  return (
    <div className="cs-detail">
      <div className="ws-title">
        <div className="cs-head">
          <span className="cs-meta">
            Requested by {view.requestedBy} · {formatWhen(view.createdAt, now)}
          </span>
          <h1>{view.summary}</h1>
          {view.reason ? <p className="cs-reason">{view.reason}</p> : null}
        </div>
        <span className={`cs-chip cs-chip-${view.status}`}>{view.statusLabel}</span>
      </div>

      <Banner view={view} />

      <section className="cs-panel glass" aria-label="Requested changes">
        {view.invalid ? (
          <p className="cs-note">This request can&apos;t be read and can only be rejected.</p>
        ) : null}
        {view.groups.map((group, i) => (
          <div key={`${group.op}-${i}`} className="cs-group">
            <h2>{group.title}</h2>
            <div className="cs-table-wrap">
              <table className="cs-table">
                <thead>
                  <tr>
                    <th>Offer</th>
                    {pending ? <th className="cs-num">Now</th> : null}
                    <th className="cs-num">{pending ? "After" : "Set to"}</th>
                    {pending ? <th className="cs-num">Change</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((row) => (
                    <tr key={row.key} className={row.flagged ? "cs-flagged" : undefined}>
                      <td>{row.title}</td>
                      {pending ? <td className="cs-num cs-before">{row.before ?? ""}</td> : null}
                      <td className="cs-num cs-after">{row.after}</td>
                      {pending ? <td className="cs-num cs-delta">{row.delta ?? ""}</td> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
        <div className="cs-foot">
          <span>
            {pending
              ? "Approving applies every change at once and updates the storefront and agent endpoints."
              : view.resolvedAt
                ? `Decided ${formatWhen(view.resolvedAt, now)}.`
                : ""}
          </span>
          <DecisionButtons id={view.id} canApprove={!view.invalid} pending={pending} />
        </div>
      </section>
    </div>
  );
}

export default async function ChangesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/approvals");

  const selectedId = typeof params.id === "string" ? params.id : undefined;
  const page = await loadChanges(services, owner, selectedId);
  const now = new Date();

  if (!page.selected) {
    return (
      <>
        <div className="ws-title">
          <h1>Approvals</h1>
        </div>
        <section className="ib-empty glass">
          <h2>No approvals yet</h2>
          <p>
            When the business agent wants to change prices or remove offers, it asks here first.
            Nothing changes until you approve.
          </p>
        </section>
      </>
    );
  }

  return (
    <div className="cs-layout">
      <Detail view={page.selected} now={now} />
      <aside className="cs-history glass" aria-label="All approvals">
        <b>All approvals</b>
        {page.list.map((item) => (
          <Link
            key={item.id}
            href={`/app/approvals?id=${item.id}`}
            aria-current={item.id === page.selected?.id ? "true" : undefined}
          >
            <span className="cs-history-summary">{item.summary}</span>
            <span className="cs-history-meta">
              <span className={`cs-chip cs-chip-${item.status}`}>
                {CHANGE_STATUS_LABELS[item.status]}
              </span>
              {formatWhen(item.createdAt, now)}
            </span>
          </Link>
        ))}
      </aside>
    </div>
  );
}
