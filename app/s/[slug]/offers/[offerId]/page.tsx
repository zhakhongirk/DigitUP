import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getServices } from "@/server/container";
import { loadOffer, loadStore } from "@/server/storefront/data";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string; offerId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, offerId } = await params;
  const services = await getServices();
  const store = await loadStore(services, slug);
  if (!store) return { title: "Store not found" };
  const offer = await loadOffer(services, store.ctx, offerId);
  return { title: offer ? `${offer.title} | ${store.name}` : `Not found | ${store.name}` };
}

export default async function OfferPage({ params }: Props) {
  const { slug, offerId } = await params;
  const services = await getServices();
  const store = await loadStore(services, slug);
  if (!store) notFound();
  const offer = await loadOffer(services, store.ctx, offerId);
  if (!offer) notFound();

  const kicker = [offer.typeName, offer.category].filter(Boolean).join(" / ");
  const facts = offer.summary.slice(0, 3);

  return (
    <article className="sf-detail">
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

      <div className="sf-detail-panel glass">
        {offer.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={offer.imageUrl} alt={offer.title} className="sf-detail-media" />
        ) : (
          <div className="sf-detail-media sf-tile">
            <span className="sf-tile-name">{offer.tileLabel}</span>
            <span className="sf-tile-note">Photo coming soon</span>
          </div>
        )}

        <div className="sf-detail-info">
          <p className="sf-card-meta">{kicker}</p>
          <h1 className="sf-detail-title">{offer.title}</h1>
          {facts.length > 0 ? <p className="sf-card-meta">{facts.join(" · ")}</p> : null}

          <div className="sf-detail-buy">
            <span
              className={
                offer.hasPrice
                  ? "sf-price sf-price-large"
                  : "sf-price sf-price-large sf-price-missing"
              }
            >
              {offer.priceLabel}
            </span>
            <span className={`status status-${offer.availability}`}>{offer.availabilityLabel}</span>
          </div>

          {offer.description ? <p className="sf-description">{offer.description}</p> : null}

          <div className="sf-detail-actions">
            <a href="#store-chat" className={offer.canOrder ? "btn" : "btn btn-secondary"}>
              Ask the store
            </a>
            {offer.canOrder ? null : (
              <p className="sf-hint">
                {offer.hasPrice
                  ? "This item cannot be ordered right now."
                  : "The store has not set a price yet."}{" "}
                Ask the store to confirm details.
              </p>
            )}
          </div>
        </div>
      </div>

      {offer.attributes.length > 0 ? (
        <section className="sf-attrs-panel glass" aria-labelledby="sf-details-title">
          <h2 id="sf-details-title">Details</h2>
          <dl className="sf-attr-table">
            {offer.attributes.map((a) => (
              <div key={a.key}>
                <dt>{a.label}</dt>
                <dd>{a.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </article>
  );
}
