import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getServices } from "@/server/container";
import { formatDateTime } from "@/server/time";
import { t } from "@/server/storefront/i18n";
import { loadOrderStatus } from "@/server/storefront/order-status";
import { storefrontLang } from "../../lang";
import "./order-status.css";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string; orderId: string }> };

export const metadata: Metadata = { title: "Order status", robots: { index: false } };

export default async function OrderStatusPage({ params }: Props) {
  const { slug, orderId } = await params;
  const lang = await storefrontLang();
  const view = await loadOrderStatus(await getServices(), slug, orderId, lang);
  if (!view) notFound();

  return (
    <article className="os">
      <Link href={`/s/${slug}`} className="sf-back">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          aria-hidden="true"
        >
          <path d="M15 5l-7 7 7 7" />
        </svg>
        {t(lang, "backToCatalog")}
      </Link>

      <section className="os-panel glass" aria-labelledby="os-title">
        <header className="os-head">
          <div>
            <p className="sf-card-meta">{view.storeName}</p>
            <h1 id="os-title" className="os-title">
              {t(lang, "orderTitle", { number: view.number })}
            </h1>
            {view.firstName ? (
              <p className="os-meta">{t(lang, "orderFor", { name: view.firstName })}</p>
            ) : null}
          </div>
          <span className={view.cancelled ? "chip chip-warn" : "chip chip-ok"}>
            {view.statusLabel}
          </span>
        </header>

        {view.cancelled ? null : (
          <ol className="os-steps" aria-label={t(lang, "orderProgress")}>
            {view.steps.map((step) => (
              <li
                key={step.key}
                className={`os-step os-step-${step.state}`}
                aria-current={step.state === "current" ? "step" : undefined}
              >
                <span className="os-dot" aria-hidden="true" />
                <span>{step.label}</span>
              </li>
            ))}
          </ol>
        )}

        <p className="os-note">{view.note}</p>
        {view.cancelReason ? (
          <p className="os-meta">{t(lang, "cancelledReason", { reason: view.cancelReason })}</p>
        ) : null}
        {view.kaspi ? (
          <p className="os-meta">
            {t(lang, "payWithKaspi")}:{" "}
            {view.kaspi.href ? (
              <a href={view.kaspi.href} target="_blank" rel="noopener noreferrer">
                {view.kaspi.value}
              </a>
            ) : (
              view.kaspi.value
            )}
          </p>
        ) : null}
        <p className="os-meta">{t(lang, "orderQuestions")}</p>
        {view.whatsappHref ? (
          <a
            className="btn btn-secondary btn-sm os-wa"
            href={view.whatsappHref}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t(lang, "writeWhatsapp")}
          </a>
        ) : null}
        <p className="os-meta">
          {t(lang, "lastUpdated")}{" "}
          <time dateTime={view.updatedAt.toISOString()}>{formatDateTime(view.updatedAt)}</time>
        </p>
      </section>

      <section className="os-panel glass" aria-labelledby="os-items-title">
        <h2 id="os-items-title">{t(lang, "items")}</h2>
        <ul className="os-lines">
          {view.lines.map((line, i) => (
            <li key={i}>
              <span>
                {line.title}
                {line.sizeLabel ? <span className="os-qty"> · {line.sizeLabel}</span> : null}
                <span className="os-qty">
                  {t(lang, "qtyAt", { quantity: line.quantity, price: line.unitPriceLabel })}
                </span>
              </span>
              <span>{line.lineTotalLabel}</span>
            </li>
          ))}
          {view.totalLabel ? (
            <li className="os-total">
              <b>{t(lang, "total")}</b>
              <b>{view.totalLabel}</b>
            </li>
          ) : null}
        </ul>
      </section>
    </article>
  );
}
