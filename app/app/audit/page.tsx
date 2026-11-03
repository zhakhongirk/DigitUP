import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import {
  AUDIT_ACTORS,
  actionLabel,
  actorLabel,
  auditChange,
  auditHref,
  parseAuditActor,
  resolveAuditTargets,
} from "@/server/owner/audit";
import { formatWhen } from "@/server/owner/inbox";
import { parsePage } from "@/server/owner/inbox";
import { ownerMeta, ownerT } from "@/server/owner/lang";
import { ownerOnly } from "@/server/owner/access";
import { currentOwner } from "@/server/owner/session";
import { Pager } from "../pager";

export const generateMetadata = (): Promise<Metadata> => ownerMeta("nav.audit");

const PAGE_SIZE = 50;

const ACTOR_INITIALS = {
  owner: "au.initialsOwner",
  business_agent: "au.initialsBusiness",
  customer_agent: "au.initialsCustomer",
  system: "au.initialsSystem",
} as const;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const services = await getServices();
  const [{ t, lang }, owner] = await Promise.all([ownerT(), currentOwner(services)]);
  if (!owner) redirect("/signin?next=/app/audit");
  ownerOnly(owner);

  const all = params.all === "1";
  const excludeAction = all ? undefined : "conversation.created";
  const actor = parseAuditActor(params.actor) ?? undefined;
  const total = await services.audit.count(owner, { excludeAction, actor });
  const pageCount = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const page = Math.min(parsePage(params.page), pageCount);
  const events = await services.audit.list(owner, {
    excludeAction,
    actor,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const targets = await resolveAuditTargets(services, owner, events, lang);
  const now = new Date();

  return (
    <>
      <div className="ws-title">
        <div className="ws-heading">
          <h1>{t("au.title")}</h1>
          <p className="ws-sub">{t("au.sub")}</p>
        </div>
        <nav className="segmented segmented-sm" aria-label={t("au.filterLabel")}>
          <Link href={auditHref({ actor })} aria-current={all ? undefined : "page"}>
            {t("au.changes")}
          </Link>
          <Link href={auditHref({ all: true, actor })} aria-current={all ? "page" : undefined}>
            {t("au.all")}
          </Link>
        </nav>
      </div>
      <nav className="segmented segmented-sm au-actors" aria-label={t("au.actorFilter")}>
        <Link href={auditHref({ all })} aria-current={actor ? undefined : "page"}>
          {t("au.anyActor")}
        </Link>
        {AUDIT_ACTORS.map((value) => (
          <Link
            key={value}
            href={auditHref({ all, actor: value })}
            aria-current={actor === value ? "page" : undefined}
          >
            {actorLabel(value, lang)}
          </Link>
        ))}
      </nav>
      <section className="au-list glass" aria-label={t("au.listLabel")}>
        {events.length === 0 ? (
          <p className="au-empty">{t("au.empty")}</p>
        ) : (
          <ol>
            {events.map((event) => {
              const change = auditChange(event, lang);
              const target = targets.get(event.id);
              return (
                <li key={event.id}>
                  <time dateTime={event.createdAt.toISOString()} className="au-when">
                    {formatWhen(event.createdAt, now, undefined, lang)}
                  </time>
                  <span className="au-actor">
                    <span className={`au-avatar au-avatar-${event.actor}`} aria-hidden="true">
                      {t(ACTOR_INITIALS[event.actor])}
                    </span>
                    {actorLabel(event.actor, lang)}
                  </span>
                  <span className="au-action" title={event.action}>
                    {actionLabel(event.action, lang)}
                  </span>
                  <span className="au-what">
                    {target ? (
                      <b>
                        {target.href ? <Link href={target.href}>{target.name}</Link> : target.name}
                      </b>
                    ) : null}
                    {change ? <span className="au-change">{change}</span> : null}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>
      <Pager page={page} pageCount={pageCount} href={(n) => auditHref({ all, actor, page: n })} />
    </>
  );
}
