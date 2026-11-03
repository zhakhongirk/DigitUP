import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import type { OfferView } from "@/server/services/catalog";
import {
  AVAILABILITIES,
  AVAILABILITY_LABELS,
  PAGE_SIZE,
  type CatalogParams,
  STATUS_FILTERS,
  STATUS_FILTER_LABELS,
  catalogHref,
  matchesFilters,
  pageCount,
  parseCatalogParams,
  statusesFor,
  toFormValues,
  toRow,
} from "@/server/owner/catalog";
import { currentOwner } from "@/server/owner/session";
import { addOffer } from "./actions";
import { OfferForm } from "./offer-form";
import "./catalog.css";

export const metadata: Metadata = { title: "Catalog" };

type Services = Awaited<ReturnType<typeof getServices>>;
type Owner = NonNullable<Awaited<ReturnType<typeof currentOwner>>>;

async function searchFiltered(
  services: Services,
  owner: Owner,
  base: { query?: string; category?: string; statuses: ReturnType<typeof statusesFor> },
  params: CatalogParams,
) {
  const matches: OfferView[] = [];
  for (let offset = 0; offset < 5000; offset += 100) {
    const batch = await services.catalog.searchOffers(owner, { ...base, limit: 100, offset });
    matches.push(...batch.items.filter((offer) => matchesFilters(offer, params)));
    if (batch.items.length < 100) break;
  }
  const start = (params.page - 1) * PAGE_SIZE;
  return { items: matches.slice(start, start + PAGE_SIZE), total: matches.length };
}

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = parseCatalogParams(await searchParams);
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/catalog");

  const base = {
    query: params.q || undefined,
    category: params.category || undefined,
    statuses: statusesFor(params.status),
  };
  const needsInfoFilter = Boolean(params.availability || params.priceOnRequest);

  const [result, categories, selected, everything] = await Promise.all([
    needsInfoFilter
      ? searchFiltered(services, owner, base, params)
      : services.catalog.searchOffers(owner, {
          ...base,
          limit: PAGE_SIZE,
          offset: (params.page - 1) * PAGE_SIZE,
        }),
    services.catalog.listCategories(owner),
    params.offerId ? services.catalog.getOffer(owner, params.offerId) : null,
    services.catalog.searchOffers(owner, { statuses: statusesFor("all"), limit: 1 }),
  ]);

  const rows = result.items.map(toRow);
  const pages = pageCount(result.total);
  const filtered = Boolean(
    params.q || params.category || params.status !== "active" || needsInfoFilter,
  );
  const closeHref = catalogHref({ ...params, offerId: null });

  return (
    <>
      <div className="ws-title">
        <div>
          <h1>Catalog</h1>
          <p className="ws-sub">
            {result.total} {result.total === 1 ? "offer" : "offers"}
          </p>
        </div>
        <div className="ct-head-actions">
          <form action={addOffer} className="ct-add">
            <button type="submit" className="btn btn-sm">
              Add offer
            </button>
          </form>
          <a href="/app/export/catalog" className="btn btn-sm btn-secondary" download>
            Export CSV
          </a>
          <Link href="/app/catalog/import" className="btn btn-sm btn-secondary">
            Update from file
          </Link>
        </div>
      </div>

      {everything.total === 0 ? (
        <section className="ib-empty glass">
          <h2>No offers yet</h2>
          <p>Offers appear here once your business model is set up.</p>
        </section>
      ) : (
        <div className="ct-grid">
          <section className="ct-list glass" aria-label="Offers">
            <form className="ct-filters" action="/app/catalog" method="get">
              <label className="field ct-search">
                <span className="sr-only">Search offers</span>
                <input type="search" name="q" defaultValue={params.q} placeholder="Search offers" />
              </label>
              <select
                name="category"
                defaultValue={params.category}
                className="ct-select"
                aria-label="Category"
              >
                <option value="">All categories</option>
                {categories.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
              <select
                name="availability"
                defaultValue={params.availability}
                className="ct-filter-select"
                aria-label="Availability"
              >
                <option value="">Any availability</option>
                {AVAILABILITIES.map((value) => (
                  <option key={value} value={value}>
                    {AVAILABILITY_LABELS[value]}
                  </option>
                ))}
              </select>
              <label className="ct-check-inline">
                <input
                  type="checkbox"
                  name="price"
                  value="on_request"
                  defaultChecked={params.priceOnRequest}
                />
                Price on request
              </label>
              {params.status !== "active" ? (
                <input type="hidden" name="status" value={params.status} />
              ) : null}
              <button type="submit" className="btn btn-sm">
                Search
              </button>
            </form>

            <nav className="segmented ct-status" aria-label="Status">
              {STATUS_FILTERS.map((status) => (
                <Link
                  key={status}
                  href={catalogHref({ ...params, status, page: 1, offerId: null })}
                  aria-current={status === params.status ? "page" : undefined}
                >
                  {STATUS_FILTER_LABELS[status]}
                </Link>
              ))}
            </nav>

            {rows.length === 0 ? (
              <div className="ct-none">
                <h2>{filtered ? "No offers match" : "No active offers"}</h2>
                <p>
                  {filtered
                    ? "Try a different search, category, status or filter."
                    : "Switch the status filter to see drafts and archived offers."}
                </p>
                {filtered ? (
                  <Link href="/app/catalog" className="btn btn-sm btn-secondary">
                    Clear filters
                  </Link>
                ) : null}
              </div>
            ) : (
              <div className="ct-table-wrap">
                <table className="ct-table">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th className="ct-wide">Category</th>
                      <th className="ct-num">Price</th>
                      <th>Availability</th>
                      <th className="ct-wide">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id} aria-selected={row.id === params.offerId}>
                        <td>
                          <Link
                            href={catalogHref({ ...params, offerId: row.id })}
                            className="ct-title"
                          >
                            {row.title}
                          </Link>
                        </td>
                        <td className="ct-muted ct-wide">{row.category || "None"}</td>
                        <td className="ct-num">{row.price}</td>
                        <td>
                          <span className={`status status-${row.availability}`}>
                            {row.availabilityLabel}
                          </span>
                        </td>
                        <td className="ct-wide">
                          <span className={`ct-chip ct-chip-${row.status}`}>{row.statusLabel}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {pages > 1 ? (
              <nav className="ct-pager" aria-label="Pages">
                {params.page > 1 ? (
                  <Link
                    href={catalogHref({ ...params, page: params.page - 1, offerId: null })}
                    className="btn btn-sm btn-secondary"
                  >
                    Previous
                  </Link>
                ) : (
                  <span />
                )}
                <span className="ct-muted">
                  Page {params.page} of {pages}
                </span>
                {params.page < pages ? (
                  <Link
                    href={catalogHref({ ...params, page: params.page + 1, offerId: null })}
                    className="btn btn-sm btn-secondary"
                  >
                    Next
                  </Link>
                ) : (
                  <span />
                )}
              </nav>
            ) : null}
          </section>

          {params.offerId ? (
            <aside className="ct-panel glass" aria-label="Edit offer">
              {selected ? (
                <>
                  <header className="ct-panel-head">
                    <div>
                      <span className="ct-muted">{selected.offerTypeName}</span>
                      <h2>{selected.title}</h2>
                    </div>
                    <Link href={closeHref} className="btn btn-sm btn-secondary">
                      Close
                    </Link>
                  </header>
                  <OfferForm
                    key={selected.id}
                    id={selected.id}
                    values={toFormValues(selected)}
                    archived={selected.status === "archived"}
                    categories={categories}
                  />
                </>
              ) : (
                <div className="ct-none">
                  <h2>Offer not found</h2>
                  <p>It may have been removed.</p>
                  <Link href={closeHref} className="btn btn-sm btn-secondary">
                    Close
                  </Link>
                </div>
              )}
            </aside>
          ) : null}
        </div>
      )}
    </>
  );
}
