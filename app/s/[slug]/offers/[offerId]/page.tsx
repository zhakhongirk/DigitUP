import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getServices } from "@/server/container";
import { appBaseUrl } from "@/server/owner/base-url";
import { loadOffer, loadStore } from "@/server/storefront/data";
import { t } from "@/server/storefront/i18n";
import {
  absoluteImageUrl,
  buildPageMeta,
  jsonLdString,
  offerPath,
  productJsonLd,
} from "@/server/storefront/seo";
import { orderMessage, questionDraft } from "../../chat-bridge";
import { storefrontLang } from "../../lang";
import { OfferImage } from "../../offer-image";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string; offerId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, offerId } = await params;
  const services = await getServices();
  const store = await loadStore(services, slug);
  if (!store) return { title: "Store not found" };
  const offer = await loadOffer(services, store.ctx, offerId);
  if (!offer) return { title: `Not found | ${store.name}` };
  const title = `${offer.title} | ${store.name}`;
  const meta = buildPageMeta({
    title,
    description: offer.description || [offer.typeName, offer.category].filter(Boolean).join(" / "),
    path: offerPath(slug, offer.id),
    baseUrl: await appBaseUrl(),
    image: offer.imageUrl,
    siteName: store.name,
  });
  return { ...meta, title: { absolute: title } };
}

export default async function OfferPage({ params }: Props) {
  const { slug, offerId } = await params;
  const lang = await storefrontLang();
  const services = await getServices();
  const store = await loadStore(services, slug);
  if (!store) notFound();
  const offer = await loadOffer(services, store.ctx, offerId);
  if (!offer) notFound();

  const baseUrl = await appBaseUrl();
  const ld = productJsonLd({
    name: offer.title,
    description: offer.description,
    url: `${baseUrl}${offerPath(slug, offer.id)}`,
    image: absoluteImageUrl(offer.imageUrl, baseUrl),
    category: offer.category,
    price: offer.price,
    currency: offer.currency,
    availability: offer.availability,
  });
  const kicker = [offer.typeName, offer.category].filter(Boolean).join(" / ");
  const facts = offer.summary.slice(0, 3);
  const bookable = offer.kind === "service" && offer.hasPrice;

  return (
    <article className="sf-detail">
      {ld ? (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdString(ld) }} />
      ) : null}
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

      <div className="sf-detail-panel glass">
        {offer.imageUrl ? (
          <OfferImage
            src={offer.imageUrl}
            alt={offer.title}
            className="sf-detail-media"
            size={800}
            sizes="(max-width: 860px) 100vw, 520px"
            priority
          />
        ) : (
          <div className="sf-detail-media sf-tile">
            <span className="sf-tile-name">{offer.tileLabel}</span>
            <span className="sf-tile-note">{t(lang, "photoSoon")}</span>
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
              {offer.hasPrice ? offer.priceLabel : t(lang, "priceOnRequest")}
            </span>
            <span className={`status status-${offer.availability}`}>{offer.availabilityLabel}</span>
          </div>

          {offer.description ? <p className="sf-description">{offer.description}</p> : null}

          <div className="sf-detail-actions">
            {bookable || offer.canOrder ? (
              <a
                href="#store-chat"
                className="btn"
                data-chat-send={orderMessage(offer.title, bookable ? "book" : "order")}
              >
                {t(lang, bookable ? "book" : "order")}
              </a>
            ) : null}
            <a
              href="#store-chat"
              className="btn btn-secondary"
              data-chat-draft={questionDraft(offer.title)}
            >
              {t(lang, "askStore")}
            </a>
            {bookable || offer.canOrder ? null : (
              <p className="sf-hint">
                {t(lang, offer.hasPrice ? "cannotOrder" : "noPriceYet")} {t(lang, "askConfirm")}
              </p>
            )}
          </div>
        </div>
      </div>

      {offer.attributes.length > 0 ? (
        <section className="sf-attrs-panel glass" aria-labelledby="sf-details-title">
          <h2 id="sf-details-title">{t(lang, "details")}</h2>
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
