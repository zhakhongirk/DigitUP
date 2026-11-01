import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getServices } from "@/server/container";
import {
  listStoreCategories,
  loadStore,
  PAGE_SIZE,
  parsePage,
  searchCatalog,
  type OfferCardData,
} from "@/server/storefront/data";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
type Props = { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { slug } = await params;
  const store = await loadStore(await getServices(), slug);
  return { title: store ? `${store.name} catalog` : "Store not found" };
}

function href(slug: string, query: string, category: string | null, page?: number): string {
  const qs = new URLSearchParams();
  if (query) qs.set("q", query);
  if (category) qs.set("category", category);
  if (page && page > 1) qs.set("page", String(page));
  const text = qs.toString();
  return text ? `/s/${slug}?${text}` : `/s/${slug}`;
}

function Media({ offer, className }: { offer: OfferCardData; className: string }) {
  if (offer.imageUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={offer.imageUrl} alt={offer.title} className={className} loading="lazy" />;
  }
  return (
    <div className={`${className} sf-tile`}>
      <span className="sf-tile-name">{offer.tileLabel}</span>
      <span className="sf-tile-note">Photo coming soon</span>
    </div>
  );
}

function PriceAndStatus({ offer }: { offer: OfferCardData }) {
  return (
    <>
      <span className={offer.hasPrice ? "sf-price" : "sf-price sf-price-missing"}>
        {offer.priceLabel}
      </span>
      <span className={`status status-${offer.availability}`}>{offer.availabilityLabel}</span>
    </>
  );
}

function OfferCard({ slug, offer }: { slug: string; offer: OfferCardData }) {
  const meta = [offer.category, offer.summary[0] ?? null].filter(Boolean).join(" · ");
  return (
    <li className="sf-card">
      <Media offer={offer} className="sf-card-media" />
      <div className="sf-card-text">
        <h3 className="sf-card-title">
          <Link href={`/s/${slug}/offers/${offer.id}`} className="sf-card-link">
            {offer.title}
          </Link>
        </h3>
        {meta ? <p className="sf-card-meta">{meta}</p> : null}
      </div>
      <div className="sf-card-foot">
        <PriceAndStatus offer={offer} />
      </div>
    </li>
  );
}

function ServiceRow({ slug, offer }: { slug: string; offer: OfferCardData }) {
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
        {offer.priceLabel}
      </span>
      {offer.hasPrice ? (
        <a href="#store-chat" className="btn btn-sm">
          Book
        </a>
      ) : (
        <a href="#store-chat" className="btn btn-sm btn-secondary">
          Ask the shop
        </a>
      )}
    </li>
  );
}

function countText(
  total: number,
  page: number,
  shown: number,
  category: string | null,
  query: string,
) {
  const base =
    total > shown
      ? `Showing ${(page - 1) * PAGE_SIZE + 1}–${(page - 1) * PAGE_SIZE + shown} of ${total}`
      : `${total} ${total === 1 ? "item" : "items"}`;
  return `${base}${category ? ` in ${category}` : ""}${query ? ` matching "${query}"` : ""}`;
}

export default async function CatalogPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const sp = await searchParams;
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
  const isServices = result.items.some((o) => o.kind === "service");

  return (
    <>
      <section className="sf-hero">
        <h1>{store.name}</h1>
        {store.description ? <p>{store.description}</p> : null}
      </section>

      <form method="get" action={`/s/${slug}`} role="search" className="sf-search">
        <label htmlFor="sf-q" className="field">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-4-4" />
          </svg>
          <span className="sr-only">Search the catalog</span>
          <input
            id="sf-q"
            name="q"
            type="search"
            defaultValue={query}
            placeholder="Search the catalog"
          />
        </label>
        {category ? <input type="hidden" name="category" value={category} /> : null}
        <button type="submit" className="btn btn-sm">
          Search
        </button>
      </form>

      <div className="sf-toolbar">
        {categories.length > 0 ? (
          <nav aria-label="Categories" className="segmented">
            <Link href={href(slug, query, null)} aria-current={category ? undefined : "page"}>
              All
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
          {countText(result.total, page, result.items.length, category, query)}
        </p>
      </div>

      {result.items.length === 0 ? (
        <div className="sf-empty glass">
          <p>Nothing found. Try a different search or browse all items.</p>
          <Link href={`/s/${slug}`} className="btn btn-sm btn-secondary">
            Show everything
          </Link>
        </div>
      ) : isServices ? (
        <ul className="sf-list glass">
          {result.items.map((offer) => (
            <ServiceRow key={offer.id} slug={slug} offer={offer} />
          ))}
        </ul>
      ) : (
        <ul className="sf-grid">
          {result.items.map((offer) => (
            <OfferCard key={offer.id} slug={slug} offer={offer} />
          ))}
        </ul>
      )}

      {pageCount > 1 ? (
        <nav aria-label="Pagination" className="sf-pagination">
          {page > 1 ? (
            <Link
              href={href(slug, query, category, page - 1)}
              rel="prev"
              className="btn btn-sm btn-secondary"
            >
              Previous
            </Link>
          ) : (
            <span aria-hidden="true" />
          )}
          <span className="sf-count">
            Page {page} of {pageCount}
          </span>
          {page < pageCount ? (
            <Link
              href={href(slug, query, category, page + 1)}
              rel="next"
              className="btn btn-sm btn-secondary"
            >
              Next
            </Link>
          ) : (
            <span aria-hidden="true" />
          )}
        </nav>
      ) : null}
    </>
  );
}
