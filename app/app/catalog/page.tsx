import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { buildGroups, type OfferView } from "@/server/services/catalog";
import {
  AVAILABILITIES,
  PAGE_SIZE,
  type CatalogParams,
  STATUS_FILTERS,
  availabilityLabel,
  catalogHref,
  matchesFilters,
  sizeAttributeTypes,
  sizeKinds,
  pageCount,
  parseCatalogParams,
  statusFilterLabel,
  statusesFor,
  toFormValues,
  toGroupRows,
} from "@/server/owner/catalog";
import { isSegmentationConfigured } from "@/server/media/photo";
import { ownerMeta, ownerT } from "@/server/owner/lang";
import { currentOwner } from "@/server/owner/session";
import { AddOfferButton } from "./add-offer-button";
import { ModelRows } from "./model-rows";
import { OfferForm } from "./offer-form";
import "./catalog.css";

export const generateMetadata = (): Promise<Metadata> => ownerMeta("nav.catalog");

type Services = Awaited<ReturnType<typeof getServices>>;
type Owner = NonNullable<Awaited<ReturnType<typeof currentOwner>>>;

async function searchFiltered(
  services: Services,
  owner: Owner,
  base: { query?: string; category?: string; statuses: ReturnType<typeof statusesFor> },
  params: CatalogParams,
  sizeTypeKeys: ReadonlySet<string>,
) {
  const matches: OfferView[] = [];
  for (let offset = 0; offset < 5000; offset += 100) {
    const batch = await services.catalog.searchOffers(owner, { ...base, limit: 100, offset });
    matches.push(...batch.items.filter((offer) => matchesFilters(offer, params, sizeTypeKeys)));
    if (batch.items.length < 100) break;
  }
  const groups = buildGroups(matches, matches);
  const start = (params.page - 1) * PAGE_SIZE;
  return { groups: groups.slice(start, start + PAGE_SIZE), total: groups.length };
}

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = parseCatalogParams(await searchParams);
  const services = await getServices();
  const [{ t, tn, lang }, owner] = await Promise.all([ownerT(), currentOwner(services)]);
  if (!owner) redirect("/signin?next=/app/catalog");

  const base = {
    query: params.q || undefined,
    category: params.category || undefined,
    statuses: statusesFor(params.status),
  };
  const needsInfoFilter = Boolean(params.availability || params.priceOnRequest || params.missing);
  const types = await services.catalog.listOfferTypes(owner);
  const kinds = sizeKinds(types);

  const [result, categories, selected, everything] = await Promise.all([
    needsInfoFilter
      ? searchFiltered(services, owner, base, params, new Set(kinds.keys()))
      : services.catalog.searchGroups(owner, {
          ...base,
          limit: PAGE_SIZE,
          offset: (params.page - 1) * PAGE_SIZE,
        }),
    services.catalog.listCategories(owner),
    params.offerId ? services.catalog.getOffer(owner, params.offerId) : null,
    services.catalog.searchOffers(owner, { statuses: statusesFor("all"), limit: 1 }),
  ]);

  const groupRows = toGroupRows(result.groups, lang, params.offerId);
  const sizeTypes = sizeAttributeTypes(types);
  const pages = pageCount(result.total);
  const filtered = Boolean(
    params.q || params.category || params.status !== "active" || needsInfoFilter,
  );
  const needsChips = [
    {
      key: "price",
      label: t("ct.missingPrice"),
      active: params.priceOnRequest,
      toggle: { priceOnRequest: !params.priceOnRequest },
    },
    {
      key: "photo",
      label: t("ct.missingPhoto"),
      active: params.missing === "photo",
      toggle: { missing: params.missing === "photo" ? ("" as const) : ("photo" as const) },
    },
    {
      key: "availability",
      label: t("ct.missingAvailability"),
      active: params.availability === "unknown",
      toggle: {
        availability: params.availability === "unknown" ? ("" as const) : ("unknown" as const),
      },
    },
    ...(kinds.size > 0
      ? [
          {
            key: "sizes",
            label: t("ct.missingSizes"),
            active: params.missing === "sizes",
            toggle: { missing: params.missing === "sizes" ? ("" as const) : ("sizes" as const) },
          },
        ]
      : []),
  ];
  const closeHref = catalogHref({ ...params, offerId: null });

  return (
    <>
      <div className="ws-title">
        <div>
          <h1>{t("ct.title")}</h1>
          <p className="ws-sub">{tn("ct.count", result.total)}</p>
        </div>
        <div className="ct-head-actions">
          <AddOfferButton />
          <a href="/app/export/catalog" className="btn btn-sm btn-secondary" download>
            {t("ct.exportCsv")}
          </a>
          {owner.role === "staff" ? null : (
            <Link href="/app/catalog/import" className="btn btn-sm btn-secondary">
              {t("ct.updateFromFile")}
            </Link>
          )}
        </div>
      </div>

      {everything.total === 0 ? (
        <section className="ib-empty glass">
          <h2>{t("ct.emptyTitle")}</h2>
          <p>{t("ct.emptyBody")}</p>
        </section>
      ) : (
        <div className="ct-grid">
          <section className="ct-list glass" aria-label={t("ct.offers")}>
            <form className="ct-filters" action="/app/catalog" method="get">
              <label className="field ct-search">
                <span className="sr-only">{t("ct.searchLabel")}</span>
                <input
                  type="search"
                  name="q"
                  defaultValue={params.q}
                  placeholder={t("ct.searchPlaceholder")}
                />
              </label>
              <select
                name="category"
                defaultValue={params.category}
                className="ct-select"
                aria-label={t("ct.category")}
              >
                <option value="">{t("ct.allCategories")}</option>
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
                aria-label={t("ct.availability")}
              >
                <option value="">{t("ct.anyAvailability")}</option>
                {AVAILABILITIES.map((value) => (
                  <option key={value} value={value}>
                    {availabilityLabel(lang, value)}
                  </option>
                ))}
              </select>
              {params.status !== "active" ? (
                <input type="hidden" name="status" value={params.status} />
              ) : null}
              {params.priceOnRequest ? (
                <input type="hidden" name="price" value="on_request" />
              ) : null}
              {params.missing ? (
                <input type="hidden" name="missing" value={params.missing} />
              ) : null}
              <button type="submit" className="btn btn-sm">
                {t("ct.search")}
              </button>
            </form>

            <nav className="ct-needs" aria-label={t("ct.needsInfo")}>
              {needsChips.map((chip) => (
                <Link
                  key={chip.key}
                  href={catalogHref({ ...params, ...chip.toggle, page: 1, offerId: null })}
                  className="ct-need"
                  aria-current={chip.active ? "true" : undefined}
                >
                  {chip.label}
                </Link>
              ))}
            </nav>

            <nav className="segmented ct-status" aria-label={t("ct.status")}>
              {STATUS_FILTERS.map((status) => (
                <Link
                  key={status}
                  href={catalogHref({ ...params, status, page: 1, offerId: null })}
                  aria-current={status === params.status ? "page" : undefined}
                >
                  {statusFilterLabel(lang, status)}
                </Link>
              ))}
            </nav>

            {groupRows.length === 0 ? (
              <div className="ct-none">
                <h2>{t(filtered ? "ct.noMatch" : "ct.noActive")}</h2>
                <p>{t(filtered ? "ct.tryOther" : "ct.switchStatus")}</p>
                {filtered ? (
                  <Link href="/app/catalog" className="btn btn-sm btn-secondary">
                    {t("ct.clearFilters")}
                  </Link>
                ) : null}
              </div>
            ) : (
              <div className="ct-table-wrap">
                <table className="ct-table">
                  <thead>
                    <tr>
                      <th>{t("ct.colTitle")}</th>
                      <th className="ct-wide">{t("ct.colCategory")}</th>
                      <th className="ct-num">{t("ct.colPrice")}</th>
                      <th>{t("ct.colAvailability")}</th>
                      <th className="ct-wide">{t("ct.colStatus")}</th>
                    </tr>
                  </thead>
                  {groupRows.map((group) =>
                    group.model === null ? (
                      <tbody key={group.key}>
                        {group.rows.map((row) => (
                          <tr key={row.id} aria-selected={row.id === params.offerId}>
                            <td>
                              <Link
                                href={catalogHref({ ...params, offerId: row.id })}
                                className="ct-title"
                              >
                                {row.title}
                              </Link>
                            </td>
                            <td className="ct-muted ct-wide">
                              {row.category || t("ct.noCategory")}
                            </td>
                            <td className="ct-num">{row.price}</td>
                            <td>
                              <span className={`status status-${row.availability}`}>
                                {row.availabilityLabel}
                              </span>
                            </td>
                            <td className="ct-wide">
                              <span className={`ct-chip ct-chip-${row.status}`}>
                                {row.statusLabel}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    ) : (
                      <ModelRows
                        key={group.key}
                        group={group}
                        selectedId={params.offerId}
                        hrefFor={(id) => catalogHref({ ...params, offerId: id })}
                      />
                    ),
                  )}
                </table>
              </div>
            )}

            {pages > 1 ? (
              <nav className="ct-pager" aria-label={t("pager.label")}>
                {params.page > 1 ? (
                  <Link
                    href={catalogHref({ ...params, page: params.page - 1, offerId: null })}
                    className="btn btn-sm btn-secondary"
                  >
                    {t("pager.previous")}
                  </Link>
                ) : (
                  <span />
                )}
                <span className="ct-muted">
                  {t("pager.status", { page: params.page, total: pages })}
                </span>
                {params.page < pages ? (
                  <Link
                    href={catalogHref({ ...params, page: params.page + 1, offerId: null })}
                    className="btn btn-sm btn-secondary"
                  >
                    {t("pager.next")}
                  </Link>
                ) : (
                  <span />
                )}
              </nav>
            ) : null}
          </section>

          {params.offerId ? (
            <aside className="ct-panel glass" aria-label={t("ct.editOffer")}>
              {selected ? (
                <>
                  <header className="ct-panel-head">
                    <div>
                      <span className="ct-muted">{selected.offerTypeName}</span>
                      <h2>{selected.title}</h2>
                    </div>
                    <Link href={closeHref} className="btn btn-sm btn-secondary">
                      {t("common.close")}
                    </Link>
                  </header>
                  <OfferForm
                    key={selected.id}
                    id={selected.id}
                    values={toFormValues(
                      selected,
                      kinds.get(selected.offerTypeKey) ?? null,
                      sizeTypes.has(selected.offerTypeKey),
                    )}
                    archived={selected.status === "archived"}
                    categories={categories}
                    canClean={isSegmentationConfigured()}
                  />
                </>
              ) : (
                <div className="ct-none">
                  <h2>{t("ct.notFound")}</h2>
                  <p>{t("ct.mayBeRemoved")}</p>
                  <Link href={closeHref} className="btn btn-sm btn-secondary">
                    {t("common.close")}
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
