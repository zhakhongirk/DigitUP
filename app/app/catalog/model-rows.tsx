"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { useT } from "@/app/i18n-provider";
import type { ModelGroupRow } from "@/server/owner/catalog";
import { setAvailability, type CatalogActionState } from "./actions";

const INITIAL: CatalogActionState = { error: null, saved: false };

export function ModelRows({
  group,
  hrefFor,
  selectedId,
}: {
  group: ModelGroupRow;
  hrefFor: (id: string) => string;
  selectedId: string | null;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(group.selected);
  const [stock, toggleStock] = useActionState(setAvailability, INITIAL);
  const model = group.model ?? "";
  return (
    <tbody className="ct-model">
      <tr className="ct-model-head">
        <td>
          <button
            type="button"
            className="ct-model-toggle"
            aria-expanded={open}
            aria-label={t("ct.toggleModel", { model })}
            onClick={() => setOpen((value) => !value)}
          >
            <span className="ct-model-caret" aria-hidden="true">
              {open ? "-" : "+"}
            </span>
            <span className="ct-title">{model}</span>
          </button>
          <span className="ct-muted ct-model-count">
            {t("ct.modelSummary", { inStock: group.inStock, total: group.rows.length })}
          </span>
        </td>
        <td className="ct-wide" />
        <td className="ct-num">{group.priceLabel}</td>
        <td />
        <td className="ct-wide" />
      </tr>
      {open
        ? group.rows.map((row) => (
            <tr key={row.id} className="ct-variant" aria-selected={row.id === selectedId}>
              <td>
                <Link href={hrefFor(row.id)} className="ct-title">
                  {row.size || row.title}
                </Link>
              </td>
              <td className="ct-wide ct-muted">{row.category}</td>
              <td className="ct-num">{row.price}</td>
              <td>
                <form action={toggleStock} className="ct-stock">
                  <input type="hidden" name="id" value={row.id} />
                  <input
                    type="hidden"
                    name="availability"
                    value={row.availability === "in_stock" ? "out_of_stock" : "in_stock"}
                  />
                  <button
                    type="submit"
                    className={`status status-${row.availability} ct-stock-btn`}
                    aria-label={t(
                      row.availability === "in_stock" ? "ct.markOutOfStock" : "ct.markInStock",
                      { size: row.size || row.title },
                    )}
                  >
                    {row.availabilityLabel}
                  </button>
                </form>
              </td>
              <td className="ct-wide">
                <span className={`ct-chip ct-chip-${row.status}`}>{row.statusLabel}</span>
              </td>
            </tr>
          ))
        : null}
      {open && stock.error ? (
        <tr>
          <td colSpan={5} className="ct-muted" role="alert">
            {stock.error}
          </td>
        </tr>
      ) : null}
    </tbody>
  );
}
