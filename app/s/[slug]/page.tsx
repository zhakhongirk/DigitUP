import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getServices } from "@/server/container";
import {
  listStoreCategories,
  loadStore,
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

function OfferCard({ slug, offer }: { slug: string; offer: OfferCardData }) {
  return (
    <li className="sf-card">
      <h3 className="sf-card-title">
        <Link href={`/s/${slug}/offers/${offer.id}`}>{offer.title}</Link>
      </h3>
      {offer.category ? <p className="sf-card-category">{offer.category}</p> : null}
      {offer.attributes.length > 0 ? (
        <dl className="sf-attrs">
          {offer.attributes.map((a) => (
            <div key={a.key}>
              <dt>{a.label}</dt>
              <dd>{a.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <p className={offer.hasPrice ? "sf-price" : "sf-price sf-price-missing"}>
        {offer.priceLabel}
      </p>
      <p>
        <span className={`sf-badge sf-badge-${offer.availability}`}>{offer.availabilityLabel}</span>
      </p>
      {offer.canOrder ? null : <p className="sf-hint">Ask the store</p>}
    </li>
  );
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

  return (
    <>
      <form method="get" action={`/s/${slug}`} role="search" className="sf-search">
        <label htmlFor="sf-q">Search the catalog</label>
        <div className="sf-search-row">
          <input id="sf-q" name="q" type="search" defaultValue={query} placeholder="Search" />
          {category ? <input type="hidden" name="category" value={category} /> : null}
          <button type="submit">Search</button>
        </div>
      </form>

      {categories.length > 0 ? (
        <nav aria-label="Categories" className="sf-categories">
          <ul>
            <li>
              <Link href={href(slug, query, null)} aria-current={category ? undefined : "page"}>
                All
              </Link>
            </li>
            {categories.map((c) => (
              <li key={c}>
                <Link
                  href={href(slug, query, c)}
                  aria-current={category?.toLowerCase() === c.toLowerCase() ? "page" : undefined}
                >
                  {c}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      <h2 className="sf-results-title">
        {result.total} {result.total === 1 ? "item" : "items"}
        {category ? ` in ${category}` : ""}
        {query ? ` matching "${query}"` : ""}
      </h2>

      {result.items.length === 0 ? (
        <div className="sf-empty">
          <p>Nothing found. Try a different search or browse all items.</p>
          <p>
            <Link href={`/s/${slug}`}>Show everything</Link>
          </p>
        </div>
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
            <Link href={href(slug, query, category, page - 1)} rel="prev">
              Previous
            </Link>
          ) : (
            <span aria-hidden="true" />
          )}
          <span>
            Page {page} of {pageCount}
          </span>
          {page < pageCount ? (
            <Link href={href(slug, query, category, page + 1)} rel="next">
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
