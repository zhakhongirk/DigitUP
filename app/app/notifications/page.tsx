import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { formatWhen, pageCountOf, parsePage } from "@/server/owner/inbox";
import { notificationView } from "@/server/owner/notifications";
import { ownerMeta, ownerT } from "@/server/owner/lang";
import { currentOwner } from "@/server/owner/session";
import { Pager } from "../pager";
import { markAllRead, openNotification } from "./actions";
import "./notifications.css";

export const generateMetadata = (): Promise<Metadata> => ownerMeta("nt.title");

const PAGE_SIZE = 25;

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const services = await getServices();
  const [{ t, lang }, owner] = await Promise.all([ownerT(), currentOwner(services)]);
  if (!owner) redirect("/signin?next=/app/notifications");

  const [total, unread] = await Promise.all([
    services.notifications.count(owner),
    services.notifications.unreadCount(owner),
  ]);
  const pageCount = pageCountOf(total, PAGE_SIZE);
  const page = Math.min(parsePage(params.page), pageCount);
  const items = await services.notifications.list(owner, {
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const now = new Date();

  return (
    <>
      <div className="ws-title nt-title">
        <div>
          <h1>{t("nt.title")}</h1>
          <p className="ws-sub">{unread > 0 ? t("nt.unread", { n: unread }) : t("nt.caughtUp")}</p>
        </div>
        {unread > 0 ? (
          <form action={markAllRead}>
            <button type="submit" className="btn btn-secondary btn-sm">
              {t("nt.markAll")}
            </button>
          </form>
        ) : null}
      </div>
      {items.length === 0 ? (
        <section className="nt-empty glass">
          <h2>{t("nt.emptyTitle")}</h2>
          <p>{t("nt.emptyBody")}</p>
        </section>
      ) : (
        <section className="nt-list glass" aria-label={t("nt.title")}>
          <ol>
            {items.map((item) => {
              const view = notificationView(item, lang);
              const isUnread = item.readAt === null;
              return (
                <li key={item.id} className={isUnread ? "nt-unread" : undefined}>
                  <form action={openNotification}>
                    <input type="hidden" name="id" value={item.id} />
                    <button type="submit" className="nt-item">
                      <span className="nt-dot" aria-hidden="true" />
                      <span className="nt-text">
                        <b>
                          {view.title}
                          {isUnread ? <span className="nt-sr">{t("nt.unreadSr")}</span> : null}
                        </b>
                        <span>{view.description}</span>
                      </span>
                      <time dateTime={item.createdAt.toISOString()} className="nt-when">
                        {formatWhen(item.createdAt, now, undefined, lang)}
                      </time>
                    </button>
                  </form>
                </li>
              );
            })}
          </ol>
        </section>
      )}
      <Pager
        page={page}
        pageCount={pageCount}
        href={(n) => (n > 1 ? `/app/notifications?page=${n}` : "/app/notifications")}
      />
    </>
  );
}
