import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import {
  INBOX_FILTERS,
  bucketLabel,
  formatWhen,
  loadAgentChats,
  loadInbox,
  parseFilter,
  parseCursor,
  parsePage,
  type InboxFilter,
  type InboxItem,
} from "@/server/owner/inbox";
import { isVoiceConfigured } from "@/server/media/voice";
import { ownerMeta, ownerT } from "@/server/owner/lang";
import { currentOwner } from "@/server/owner/session";
import type { Translator } from "@/shared/owner-copy";
import { Pager } from "../pager";
import "./inbox.css";
import { ReplyForm } from "./reply-form";
import { SearchBox } from "./search-box";
import { StatusActions } from "./status-actions";

export const generateMetadata = (): Promise<Metadata> => ownerMeta("nav.inbox");

function href(
  filter: InboxFilter,
  item?: string,
  before?: string | null,
  page = 1,
  q?: string,
): string {
  const params = new URLSearchParams();
  if (filter !== "all") params.set("filter", filter);
  if (before) {
    params.set("before", before);
    params.set("page", String(page));
  }
  if (item) params.set("item", item);
  if (q) params.set("q", q);
  const query = params.toString();
  return query ? `/app/inbox?${query}` : "/app/inbox";
}

function contactLinks(value: string) {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.map((part) => {
    if (part.includes("@"))
      return [{ href: `mailto:${part}`, text: part, action: "mail" as const }];
    const digits = part.replace(/\D/g, "");
    if (digits.length < 6) return [];
    return [
      { href: `tel:+${digits}`, text: part, action: "call" as const },
      { href: `https://wa.me/${digits}`, text: part, action: "whatsapp" as const },
    ];
  });
}

function Detail({
  item,
  conversation,
  back,
  now,
  tr,
}: {
  item: InboxItem;
  conversation: Awaited<ReturnType<typeof loadInbox>>["conversation"];
  back: string;
  now: Date;
  tr: Translator;
}) {
  const { t, lang } = tr;
  const external = item.source === t("common.externalAgent");
  const actionLabels = { mail: t("ib.email"), call: t("ib.call"), whatsapp: t("ib.whatsapp") };
  return (
    <section id="detail" className="ib-detail glass" aria-labelledby="ib-detail-title">
      <header className="ib-detail-head">
        <Link className="btn btn-secondary btn-sm ib-back" href={back}>
          {t("ib.back")}
        </Link>
        <div className="ib-detail-title">
          <div>
            <span className="ib-meta">
              {t(item.kind === "order" ? "ib.kindOrder" : "ib.kindQuestion")} · {item.source} ·{" "}
              {formatWhen(item.at, now, undefined, lang)}
              {item.night ? <span className="ib-night">{item.night}</span> : null}
            </span>
            <h2 id="ib-detail-title">
              {item.label} · {item.who}
            </h2>
          </div>
          <span className={`ib-chip ib-chip-${item.bucket}`}>{item.statusLabel}</span>
        </div>
        {item.kind === "order" ? (
          <ol className="ib-steps" aria-label={t("ib.progress")}>
            {item.steps.map((step) => (
              <li
                key={step.name}
                className={`ib-step-${step.state}`}
                aria-current={step.state === "current" ? "step" : undefined}
              >
                {step.name}
              </li>
            ))}
          </ol>
        ) : null}
        <StatusActions
          kind={item.kind}
          id={item.id}
          next={item.next}
          canCancel={item.kind === "order" && item.canCancel}
          checkStock={item.kind === "order" && item.status === "submitted"}
        />
      </header>

      <div className="ib-detail-body">
        <div className="ib-conv" aria-label={t("ib.conversation")}>
          {conversation.length === 0 ? (
            <p className="ib-empty-conv">
              {item.conversationId ? t("ib.noMessages") : t("ib.noChat")}
            </p>
          ) : (
            conversation.map((line) => (
              <div key={line.id} className={`ib-msg ib-msg-${line.from}`}>
                <span className="ib-msg-who">
                  {line.from === "customer"
                    ? item.who
                    : external
                      ? t("common.externalAgent")
                      : t("ib.storeAssistant")}
                </span>
                <p>{line.text}</p>
              </div>
            ))
          )}
          {item.kind === "inquiry" && item.answer ? (
            <div className="ib-msg ib-msg-owner">
              <span className="ib-msg-who">
                {t("common.you")}
                {item.answeredAt ? ` · ${formatWhen(item.answeredAt, now, undefined, lang)}` : ""}
              </span>
              <p>{item.answer}</p>
            </div>
          ) : null}
        </div>
        <dl className="ib-facts">
          {item.facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>
                {fact.label === t("ib.contact") ? (
                  <span style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {contactLinks(fact.value).map((group) => (
                      <span key={group[0]?.href ?? fact.value}>
                        {group[0]?.text ?? ""}
                        {group.map((link) => (
                          <span key={link.href}>
                            {" "}
                            <a
                              href={link.href}
                              target={link.action === "whatsapp" ? "_blank" : undefined}
                              rel="noreferrer"
                            >
                              {actionLabels[link.action]}
                            </a>
                          </span>
                        ))}
                      </span>
                    ))}
                  </span>
                ) : (
                  fact.value
                )}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      {item.kind === "inquiry" ? (
        <ReplyForm
          key={item.id}
          id={item.id}
          answered={Boolean(item.answer)}
          voice={isVoiceConfigured()}
        />
      ) : null}
    </section>
  );
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const filter = parseFilter(params.filter);
  const selectedKey = typeof params.item === "string" ? params.item : undefined;
  const before = parseCursor(params.before);
  const requestedPage = parsePage(params.page);
  const search = typeof params.q === "string" ? params.q.trim().slice(0, 80) : "";

  const services = await getServices();
  const [tr, owner] = await Promise.all([ownerT(), currentOwner(services)]);
  if (!owner) redirect("/signin?next=/app/inbox");
  const { t, lang } = tr;

  const chatsMode = params.filter === "chats";
  const chatsView = chatsMode
    ? await loadAgentChats(services, owner, { selected: selectedKey })
    : null;
  const view = await loadInbox(services, owner, {
    lang,
    filter: chatsMode ? "all" : filter,
    selected: chatsMode ? undefined : selectedKey,
    page: requestedPage,
    search,
    before,
  });
  const current = before ? (typeof params.before === "string" ? params.before : null) : null;
  const now = new Date();

  return (
    <>
      <div className="ws-title">
        <h1>{t("ib.title")}</h1>
        <div className="segmented segmented-sm" role="group" aria-label={t("ib.status")}>
          {INBOX_FILTERS.map((f) => (
            <Link
              key={f}
              href={href(f, undefined, null, 1, search)}
              aria-current={f === filter && !chatsMode ? "page" : undefined}
            >
              {f === "all" ? t("ib.all") : bucketLabel(lang, f)}
              {f !== "all" && view.counts[f] > 0 ? (
                <span className="ib-count">{view.counts[f]}</span>
              ) : null}
            </Link>
          ))}
          <Link href="/app/inbox?filter=chats" aria-current={chatsMode ? "page" : undefined}>
            {t("ib.agentChats")}
          </Link>
        </div>
      </div>

      {chatsView ? (
        <div className="ib-grid" data-view={selectedKey ? "detail" : "list"}>
          <div className="ib-list glass">
            {chatsView.chats.length === 0 ? (
              <p className="ib-list-empty">{t("ib.noAgentChats")}</p>
            ) : (
              chatsView.chats.map((chat) => (
                <Link
                  key={chat.id}
                  href={`/app/inbox?filter=chats&item=${chat.id}#detail`}
                  className="ib-item"
                  aria-current={chat.id === chatsView.selected ? "true" : undefined}
                >
                  <span className="ib-item-row">
                    <b>{t("common.externalAgent")}</b>
                    <span className="ib-when">{formatWhen(chat.at, now, undefined, lang)}</span>
                  </span>
                  <span className="ib-item-row">
                    <span>{t("ib.agentMessages", { n: chat.messageCount })}</span>
                  </span>
                  <span className="ib-preview">{chat.firstLine}</span>
                </Link>
              ))
            )}
          </div>
          {chatsView.selected ? (
            <section id="detail" className="ib-detail glass" aria-label={t("ib.conversation")}>
              <header className="ib-detail-head">
                <Link className="btn btn-secondary btn-sm ib-back" href="/app/inbox?filter=chats">
                  {t("ib.back")}
                </Link>
              </header>
              <div className="ib-detail-body">
                <div className="ib-conv" aria-label={t("ib.conversation")}>
                  {chatsView.conversation.map((line) => (
                    <div key={line.id} className={`ib-msg ib-msg-${line.from}`}>
                      <span className="ib-msg-who">
                        {line.from === "customer"
                          ? t("common.externalAgent")
                          : t("ib.storeAssistant")}
                      </span>
                      <p>{line.text}</p>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          ) : null}
        </div>
      ) : view.counts.all === 0 ? (
        <section className="ib-empty glass">
          <h2>{t("ib.emptyTitle")}</h2>
          <p>{t("ib.emptyBody")}</p>
        </section>
      ) : (
        <div className="ib-grid" data-view={selectedKey ? "detail" : "list"}>
          <div className="ib-list glass">
            <SearchBox initial={search} filter={filter} />
            {view.items.length === 0 ? (
              <p className="ib-list-empty">{t(search ? "ib.noMatches" : "ib.nothingHere")}</p>
            ) : (
              view.items.map((item) => (
                <Link
                  key={item.key}
                  href={`${href(filter, item.key, current, view.page, search)}#detail`}
                  className="ib-item"
                  aria-current={item.key === view.selected?.key ? "true" : undefined}
                >
                  <span className="ib-item-row">
                    <b>{item.label}</b>
                    <span className="ib-when">{formatWhen(item.at, now, undefined, lang)}</span>
                  </span>
                  <span className="ib-item-row">
                    <span>{item.who}</span>
                    <span className={`ib-chip ib-chip-${item.bucket}`}>
                      {bucketLabel(lang, item.bucket)}
                    </span>
                  </span>
                  {item.night ? (
                    <span>
                      <span className="ib-night">{item.night}</span>
                    </span>
                  ) : null}
                  <span className="ib-preview">{item.preview}</span>
                </Link>
              ))
            )}
            <Pager
              page={view.page}
              pageCount={view.pageCount}
              newerHref={view.page > 1 ? href(filter, undefined, null, 1, search) : null}
              olderHref={
                view.next ? href(filter, undefined, view.next, view.page + 1, search) : null
              }
            />
          </div>
          {view.selected ? (
            <Detail
              item={view.selected}
              conversation={view.conversation}
              back={href(filter, undefined, current, view.page, search)}
              now={now}
              tr={tr}
            />
          ) : null}
        </div>
      )}
    </>
  );
}
