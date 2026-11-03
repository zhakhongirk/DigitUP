import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { ACTOR_LABELS, actionLabel, auditChange, resolveAuditTargets } from "@/server/owner/audit";
import { formatWhen } from "@/server/owner/inbox";
import { parsePage } from "@/server/owner/inbox";
import { currentOwner } from "@/server/owner/session";
import { Pager } from "../pager";

export const metadata: Metadata = { title: "Audit log" };

const PAGE_SIZE = 50;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/audit");

  const all = params.all === "1";
  const excludeAction = all ? undefined : "conversation.created";
  const total = await services.audit.count(owner, { excludeAction });
  const pageCount = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const page = Math.min(parsePage(params.page), pageCount);
  const events = await services.audit.list(owner, {
    excludeAction,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const targets = await resolveAuditTargets(services, owner, events);
  const now = new Date();

  return (
    <>
      <div className="ws-title">
        <h1>Audit log</h1>
        <p className="ws-sub">Every change to the store, by you, the agents or the system.</p>
      </div>
      <nav className="au-filter" aria-label="Audit filter">
        <Link href="/app/audit" aria-current={all ? undefined : "page"}>
          Changes
        </Link>
        <Link href="/app/audit?all=1" aria-current={all ? "page" : undefined}>
          All activity
        </Link>
      </nav>
      <section className="au-list glass" aria-label="Recent changes">
        {events.length === 0 ? (
          <p className="au-empty">No changes recorded yet.</p>
        ) : (
          <ol>
            {events.map((event) => {
              const change = auditChange(event);
              const target = targets.get(event.id);
              return (
                <li key={event.id}>
                  <span className={`au-actor au-actor-${event.actor}`}>
                    {ACTOR_LABELS[event.actor]}
                  </span>
                  <span className="au-what">
                    {actionLabel(event.action)}
                    {target ? (
                      <span className="au-change">
                        {target.href ? <Link href={target.href}>{target.name}</Link> : target.name}
                      </span>
                    ) : null}
                    {change ? <span className="au-change">{change}</span> : null}
                  </span>
                  <time dateTime={event.createdAt.toISOString()} className="au-when">
                    {formatWhen(event.createdAt, now)}
                  </time>
                </li>
              );
            })}
          </ol>
        )}
      </section>
      <Pager
        page={page}
        pageCount={pageCount}
        href={(n) => {
          const query = new URLSearchParams();
          if (all) query.set("all", "1");
          if (n > 1) query.set("page", String(n));
          const qs = query.toString();
          return qs ? `/app/audit?${qs}` : "/app/audit";
        }}
      />
    </>
  );
}
