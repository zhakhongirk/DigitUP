import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getServices } from "@/server/container";
import { appBaseUrl } from "@/server/owner/base-url";
import {
  listStoreCategories,
  loadStore,
  PAGE_SIZE,
  parsePage,
  searchCatalog,
  type OfferCardData,
} from "@/server/storefront/data";
import { t, type Lang } from "@/server/storefront/i18n";
import { buildPageMeta, jsonLdString, storeJsonLd, storePath } from "@/server/storefront/seo";
import { orderMessage, questionDraft } from "./chat-bridge";
import { availabilityText, policyLabel } from "./labels";
import { storefrontLang } from "./lang";
import { stripPolicyLabel } from "./policy";
import { OfferImage } from "./offer-image";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
type Props = { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { slug } = await params;
  const store = await loadStore(await getServices(), slug);
  if (!store) return { title: "Store not found" };
  const meta = buildPageMeta({
    title: store.name,
    description: store.description,
    path: storePath(slug),
    baseUrl: await appBaseUrl(),
    siteName: store.name,
  });
  return { ...meta, title: { absolute: store.name } };
}

function href(slug: string, query: string, category: string | null, page?: number): string {
  const qs = new URLSearchParams();
  if (query) qs.set("q", query);
  if (category) qs.set("category", category);
  if (page && page > 1) qs.set("page", String(page));
  const text = qs.toString();
  return text ? `/s/${slug}?${text}` : `/s/${slug}`;
}

function Media({
  offer,
  className,
  priority,
  lang,
}: {
  lang: Lang;
  offer: OfferCardData;
  className: string;
  priority?: boolean;
}) {
  if (offer.imageUrl) {
    return (
      <OfferImage
        src={offer.imageUrl}
        alt={offer.title}
        className={className}
        size={400}
        sizes="(max-width: 640px) 50vw, 240px"
        priority={priority}
      />
    );
  }
  return (
    <div className={`${className} sf-tile`}>
      <span className="sf-tile-name">{offer.tileLabel}</span>
      <span className="sf-tile-note">{t(lang, "photoSoon")}</span>
    </div>
  );
}

function PriceAndStatus({ offer, lang }: { offer: OfferCardData; lang: Lang }) {
  return (
    <>
      <span className={offer.hasPrice ? "sf-price" : "sf-price sf-price-missing"}>
        {offer.hasPrice ? offer.priceLabel : t(lang, "priceOnRequest")}
      </span>
      <span className={`status status-${offer.availability}`}>
        {availabilityText(lang, offer.availability)}
      </span>
    </>
  );
}

function OfferCard({
  slug,
  offer,
  priority,
  lang,
}: {
  lang: Lang;
  slug: string;
  offer: OfferCardData;
  priority?: boolean;
}) {
  const meta = [offer.category, offer.summary[0] ?? null].filter(Boolean).join(" · ");
  return (
    <li className="sf-card">
      <Media offer={offer} className="sf-card-media" priority={priority} lang={lang} />
      <div className="sf-card-text">
        <h3 className="sf-card-title">
          <Link href={`/s/${slug}/offers/${offer.id}`} className="sf-card-link">
            {offer.title}
          </Link>
        </h3>
        {meta ? <p className="sf-card-meta">{meta}</p> : null}
        {offer.sizes.length > 0 ? (
          <ul className="sf-sizes" aria-label={t(lang, "sizesLabel")}>
            {offer.sizes.map((s) => (
              <li
                key={s.id}
                className={s.available ? "sf-size" : "sf-size sf-size-off"}
                title={s.available ? undefined : t(lang, "sizeOutOfStock", { size: s.size })}
              >
                {s.size}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="sf-card-foot">
        <PriceAndStatus offer={offer} lang={lang} />
      </div>
      {offer.canOrder ? (
        <a
          href="#store-chat"
          className="btn btn-sm sf-card-order"
          data-chat-send={orderMessage(offer.title, "order")}
        >
          {t(lang, "order")}
        </a>
      ) : null}
    </li>
  );
}

function ServiceRow({ slug, offer, lang }: { slug: string; offer: OfferCardData; lang: Lang }) {
  const meta = [...offer.summary.slice(0, 2), offer.category].filter(Boolean).join(" · ");
  return (
    <li className="sf-row">
      <div className="sf-row-text">
        <h3 className="sf-row-title">
          <Link href={`/s/${slug}/offers/${offer.id}`}>{offer.title}</Link>
        </h3>
        {offer.description ? <p className="sf-row-desc">{offer.description}</p> : null}
        {meta ? <p className="sf-card-meta">{meta}</p> : null}
      </div>
      <span className={offer.hasPrice ? "sf-price" : "sf-price sf-price-missing"}>
        {offer.hasPrice ? offer.priceLabel : t(lang, "priceOnRequest")}
      </span>
      {offer.hasPrice ? (
        <a
          href="#store-chat"
          className="btn btn-sm"
          data-chat-send={orderMessage(offer.title, "book")}
        >
          {t(lang, "book")}
        </a>
      ) : (
        <a
          href="#store-chat"
          className="btn btn-sm btn-secondary"
          data-chat-draft={questionDraft(offer.title)}
        >
          {t(lang, "askShop")}
        </a>
      )}
    </li>
  );
}

function countText(
  lang: Lang,
  total: number,
  page: number,
  shown: number,
  category: string | null,
  query: string,
) {
  const base =
    total > shown
      ? t(lang, "showing", {
          from: (page - 1) * PAGE_SIZE + 1,
          to: (page - 1) * PAGE_SIZE + shown,
          total,
        })
      : t(lang, total === 1 ? "itemCountOne" : "itemCountMany", { n: total });
  const inCategory = category ? t(lang, "inCategory", { category }) : "";
  const matching = query ? t(lang, "matching", { query }) : "";
  return `${base}${inCategory}${matching}`;
}

export default async function CatalogPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const sp = await searchParams;
  const lang = await storefrontLang();
  const services = await getServices();
  const store = await loadStore(services, slug);
  if (!store) notFound();

  const [categories, result] = await Promise.all([
    listStoreCategories(services, store.ctx),
    searchCatalog(services, store.ctx, {
      query: first(sp.q),
      category: first(sp.category),
      page: parsePage(first(sp.page)),
    }),
  ]);
  const { query, category, page, pageCount } = result;
  const jsonLd = jsonLdString(
    storeJsonLd({
      name: store.name,
      description: store.description,
      url: `${await appBaseUrl()}${storePath(slug)}`,
      contacts: store.contacts,
    }),
  );
  const isServices = result.items.some((o) => o.kind === "service");

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
      <section className="sf-hero">
        <h1>{store.name}</h1>
        {store.description ? <p>{store.description}</p> : null}
      </section>

      <div className="sf-toolbar">
        {categories.length > 0 ? (
          <nav aria-label={t(lang, "categories")} className="segmented">
            <Link href={href(slug, query, null)} aria-current={category ? undefined : "page"}>
              {t(lang, "all")}
            </Link>
            {categories.map((c) => (
              <Link
                key={c}
                href={href(slug, query, c)}
                aria-current={category?.toLowerCase() === c.toLowerCase() ? "page" : undefined}
              >
                {c}
              </Link>
            ))}
          </nav>
        ) : null}
        <p className="sf-count" role="status">
          {countText(lang, result.total, page, result.items.length, category, query)}
        </p>
      </div>

      {store.policies.length > 0 ? (
        <ul className="sf-chips" aria-label={t(lang, "storePolicies")}>
          {store.policies.map((p) => {
            const tbc = p.text === "To be confirmed";
            const label = policyLabel(lang, p.key, p.label);
            const text = tbc
              ? t(lang, "policyTbc", { label })
              : `${label}: ${stripPolicyLabel(p.key, p.label, p.text)}`;
            return (
              <li key={p.key}>
                <a
                  href="#sf-policies"
                  className={tbc ? "sf-chip sf-chip-tbc" : "sf-chip"}
                  title={text}
                >
                  {text}
                </a>
              </li>
            );
          })}
        </ul>
      ) : null}

      {result.items.length === 0 ? (
        <div className="sf-empty glass">
          <p>{t(lang, "nothingFound")}</p>
          <Link href={`/s/${slug}`} className="btn btn-sm btn-secondary">
            {t(lang, "showEverything")}
          </Link>
        </div>
      ) : isServices ? (
        <ul className="sf-list glass">
          {result.items.map((offer) => (
            <ServiceRow key={offer.id} slug={slug} offer={offer} lang={lang} />
          ))}
        </ul>
      ) : (
        <ul className="sf-grid">
          {result.items.map((offer, i) => (
            <OfferCard key={offer.id} slug={slug} offer={offer} priority={i < 4} lang={lang} />
          ))}
        </ul>
      )}

      {pageCount > 1 ? (
        <nav aria-label={t(lang, "pagination")} className="sf-pagination">
          {page > 1 ? (
            <Link
              href={href(slug, query, category, page - 1)}
              rel="prev"
              className="btn btn-sm btn-secondary"
            >
              {t(lang, "previous")}
            </Link>
          ) : (
            <span aria-hidden="true" />
          )}
          <span className="sf-count">{t(lang, "pageOf", { page, total: pageCount })}</span>
          {page < pageCount ? (
            <Link
              href={href(slug, query, category, page + 1)}
              rel="next"
              className="btn btn-sm btn-secondary"
            >
              {t(lang, "next")}
            </Link>
          ) : (
            <span aria-hidden="true" />
          )}
        </nav>
      ) : null}
    </>
  );
}
