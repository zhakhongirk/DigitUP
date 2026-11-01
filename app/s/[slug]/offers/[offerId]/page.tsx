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

  return (
    <article className="sf-detail">
      <p>
        <Link href={`/s/${slug}`}>Back to catalog</Link>
      </p>
      <h2 className="sf-detail-title">{offer.title}</h2>
      <p className="sf-card-category">
        {offer.typeName}
        {offer.category ? ` / ${offer.category}` : ""}
      </p>

      <p
        className={
          offer.hasPrice ? "sf-price sf-price-large" : "sf-price sf-price-large sf-price-missing"
        }
      >
        {offer.priceLabel}
      </p>
      <p>
        <span className={`sf-badge sf-badge-${offer.availability}`}>{offer.availabilityLabel}</span>
      </p>
      {offer.canOrder ? null : <p className="sf-hint">Ask the store</p>}

      {offer.description ? <p className="sf-description">{offer.description}</p> : null}

      {offer.attributes.length > 0 ? (
        <section aria-labelledby="sf-details-title">
          <h3 id="sf-details-title">Details</h3>
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
