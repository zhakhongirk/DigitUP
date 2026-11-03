import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getServices } from "@/server/container";
import { formatDateTime } from "@/server/time";
import { loadOrderStatus } from "@/server/storefront/order-status";
import "./order-status.css";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string; orderId: string }> };

export const metadata: Metadata = { title: "Order status", robots: { index: false } };

export default async function OrderStatusPage({ params }: Props) {
  const { slug, orderId } = await params;
  const view = await loadOrderStatus(await getServices(), slug, orderId);
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
        Back to catalog
      </Link>

      <section className="os-panel glass" aria-labelledby="os-title">
        <header className="os-head">
          <div>
            <p className="sf-card-meta">{view.storeName}</p>
            <h1 id="os-title" className="os-title">
              Order {view.number}
            </h1>
            {view.firstName ? <p className="os-meta">For {view.firstName}</p> : null}
          </div>
          <span className={view.cancelled ? "chip chip-warn" : "chip chip-ok"}>
            {view.statusLabel}
          </span>
        </header>

        {view.cancelled ? null : (
          <ol className="os-steps" aria-label="Order progress">
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
        <p className="os-meta">Questions? Ask the store assistant or use the contacts above.</p>
        <p className="os-meta">
          Last updated{" "}
          <time dateTime={view.updatedAt.toISOString()}>{formatDateTime(view.updatedAt)}</time>
        </p>
      </section>

      <section className="os-panel glass" aria-labelledby="os-items-title">
        <h2 id="os-items-title">Items</h2>
        <ul className="os-lines">
          {view.lines.map((line, i) => (
            <li key={i}>
              <span>
                {line.title}
                <span className="os-qty">
                  {" "}
                  × {line.quantity} at {line.unitPriceLabel}
                </span>
              </span>
              <span>{line.lineTotalLabel}</span>
            </li>
          ))}
          {view.totalLabel ? (
            <li className="os-total">
              <b>Total</b>
              <b>{view.totalLabel}</b>
            </li>
          ) : null}
        </ul>
      </section>
    </article>
  );
}
