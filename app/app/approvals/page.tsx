import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { changeStatusLabel, loadChanges, type ChangeSetView } from "@/server/owner/changes";
import { formatWhen } from "@/server/owner/inbox";
import { ownerMeta, ownerT } from "@/server/owner/lang";
import { ownerOnly } from "@/server/owner/access";
import { currentOwner } from "@/server/owner/session";
import type { Translator } from "@/shared/owner-copy";
import { ChangeRows } from "./change-rows";

export const generateMetadata = (): Promise<Metadata> => ownerMeta("ap.title");

function Banner({ view, t }: { view: ChangeSetView; t: Translator["t"] }) {
  if (view.status === "applied") {
    return (
      <div className="cs-banner cs-banner-ok">
        <b>{t("ap.statusApplied")}</b>
        <span>{t("ap.bannerApplied")}</span>
      </div>
    );
  }
  if (view.status === "rejected") {
    return (
      <div className="cs-banner cs-banner-bad">
        <b>{t("ap.statusRejected")}</b>
        <span>{t("ap.bannerRejected")}</span>
      </div>
    );
  }
  if (view.flagged.length === 0) return null;
  const n = view.flagged.length;
  return (
    <div className="cs-banner cs-banner-warn">
      <b>{t(n === 1 ? "ap.bannerFlaggedOne" : "ap.bannerFlaggedMany", { n })}</b>
      <span>{t("ap.bannerCheck", { names: view.flagged.join(", ") })}</span>
    </div>
  );
}

function Detail({ view, now, tr }: { view: ChangeSetView; now: Date; tr: Translator }) {
  const { t, lang } = tr;
  const pending = view.status === "pending";
  return (
    <div className="cs-detail">
      <div className="ws-title">
        <div className="cs-head">
          <span className="cs-meta">
            {t("ap.requestedBy", {
              who: view.requestedBy,
              when: formatWhen(view.createdAt, now, undefined, lang),
            })}
          </span>
          <h1>{view.summary}</h1>
        </div>
        <span className={`cs-chip cs-chip-${view.status}`}>{view.statusLabel}</span>
      </div>
      {view.reason ? <p className="cs-reason">{view.reason}</p> : null}

      <Banner view={view} t={t} />

      <section className="cs-panel glass" aria-label={t("ap.requestedChanges")}>
        {view.invalid ? <p className="cs-note">{t("ap.unreadable")}</p> : null}
        <ChangeRows
          id={view.id}
          groups={view.groups}
          pending={pending}
          canApprove={!view.invalid}
          footNote={
            view.resolvedAt
              ? t("ap.decided", { when: formatWhen(view.resolvedAt, now, undefined, lang) })
              : ""
          }
        />
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
  const [tr, owner] = await Promise.all([ownerT(), currentOwner(services)]);
  if (!owner) redirect("/signin?next=/app/approvals");
  ownerOnly(owner);
  const { t, lang } = tr;

  const selectedId = typeof params.id === "string" ? params.id : undefined;
  const page = await loadChanges(services, owner, selectedId, lang);
  const now = new Date();

  if (!page.selected) {
    return (
      <>
        <div className="ws-title">
          <h1>{t("ap.title")}</h1>
        </div>
        <section className="ib-empty glass">
          <h2>{t("ap.emptyTitle")}</h2>
          <p>{t("ap.emptyBody")}</p>
        </section>
      </>
    );
  }

  return (
    <div className="cs-layout">
      <Detail view={page.selected} now={now} tr={tr} />
      <aside className="cs-history glass" aria-label={t("ap.all")}>
        <b>{t("ap.all")}</b>
        {page.list.map((item) => (
          <Link
            key={item.id}
            href={`/app/approvals?id=${item.id}`}
            aria-current={item.id === page.selected?.id ? "true" : undefined}
          >
            <span className="cs-history-summary">{item.summary}</span>
            <span className="cs-history-meta">
              <span className={`cs-chip cs-chip-${item.status}`}>
                {changeStatusLabel(lang, item.status)}
              </span>
              {formatWhen(item.createdAt, now, undefined, lang)}
            </span>
          </Link>
        ))}
      </aside>
    </div>
  );
}
