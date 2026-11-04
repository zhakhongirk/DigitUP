"use client";

import { useState } from "react";
import { useT } from "@/app/i18n-provider";
import { toUnits, type ChangeGroup, type ChangeRow, type ChangeUnit } from "@/server/owner/changes";
import { DecisionButtons } from "./decision-buttons";

function deltaClass(delta: string | null, newlyPriced: string): string {
  if (!delta) return "";
  if (delta === newlyPriced) return " cs-delta-new";
  if (delta.startsWith("+")) return " cs-delta-up";
  if (delta.startsWith("-")) return " cs-delta-down";
  return "";
}

interface Columns {
  selectable: boolean;
  pending: boolean;
  selected: ReadonlySet<string>;
  toggle: (keys: string[], on: boolean) => void;
}

function RowCells({ row, cols }: { row: ChangeRow; cols: Columns }) {
  const { t } = useT();
  const { selectable, pending, selected, toggle } = cols;
  return (
    <>
      {selectable ? (
        <td className="cs-check">
          <input
            type="checkbox"
            aria-label={t("ap.apply", { title: row.title })}
            checked={selected.has(row.key)}
            onChange={(e) => toggle([row.key], e.currentTarget.checked)}
          />
        </td>
      ) : null}
      <td>{row.title}</td>
      {pending ? (
        <td
          className={`cs-num cs-before${row.before === t("common.onRequest") ? " cs-before-none" : ""}`}
        >
          {row.before ?? ""}
        </td>
      ) : null}
      <td className="cs-num cs-after">{row.after}</td>
      {pending ? (
        <td className={`cs-num cs-delta${deltaClass(row.delta, t("ap.newlyPriced"))}`}>
          {row.delta ?? ""}
        </td>
      ) : null}
    </>
  );
}

function ModelUnit({ unit, cols }: { unit: ChangeUnit; cols: Columns }) {
  const { t, tn } = useT();
  const { selectable, pending, selected, toggle } = cols;
  const model = unit.model ?? "";
  const [open, setOpen] = useState(false);
  const keys = unit.rows.map((row) => row.key);
  const picked = keys.filter((key) => selected.has(key)).length;
  return (
    <tbody className="cs-model">
      <tr className={unit.flagged ? "cs-flagged" : undefined}>
        {selectable ? (
          <td className="cs-check">
            <input
              type="checkbox"
              aria-label={t("ap.applyModel", { model })}
              checked={picked === keys.length}
              ref={(el) => {
                if (el) el.indeterminate = picked > 0 && picked < keys.length;
              }}
              onChange={(e) => toggle(keys, e.currentTarget.checked)}
            />
          </td>
        ) : null}
        <td>
          <button
            type="button"
            className="cs-link"
            aria-expanded={open}
            aria-label={t("ap.toggleModel", { model })}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "-" : "+"} {model}
          </button>{" "}
          <span className="cs-group-count">{tn("ap.offersCount", unit.rows.length)}</span>
        </td>
        {pending ? <td className="cs-num cs-before">{unit.before ?? ""}</td> : null}
        <td className="cs-num cs-after">{unit.after}</td>
        {pending ? (
          <td className={`cs-num cs-delta${deltaClass(unit.delta, t("ap.newlyPriced"))}`}>
            {unit.delta ?? ""}
          </td>
        ) : null}
      </tr>
      {open
        ? unit.rows.map((row) => (
            <tr key={row.key} className={row.flagged ? "cs-flagged" : undefined}>
              <RowCells row={row} cols={cols} />
            </tr>
          ))
        : null}
    </tbody>
  );
}

export function ChangeRows({
  id,
  groups,
  pending,
  canApprove,
  footNote,
}: {
  id: string;
  groups: ChangeGroup[];
  pending: boolean;
  canApprove: boolean;
  footNote: string;
}) {
  const { t, tn } = useT();
  const allKeys = groups.flatMap((group) => group.rows.map((row) => row.key));
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(allKeys));
  const selectable = pending && canApprove;

  function toggle(keys: string[], on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  }

  const cols: Columns = { selectable, pending, selected, toggle };

  return (
    <>
      {groups.map((group, i) => {
        const keys = group.rows.map((row) => row.key);
        const picked = keys.filter((key) => selected.has(key)).length;
        return (
          <div key={`${group.op}-${i}`} className="cs-group">
            <div className="cs-group-head">
              <h2>{group.title}</h2>
              <span className="cs-group-count">
                {tn("ap.offersCount", group.rows.length)}
                {selectable ? (
                  <>
                    {" · "}
                    <button type="button" className="cs-link" onClick={() => toggle(keys, true)}>
                      {t("ap.selectAll")}
                    </button>
                    {" · "}
                    <button type="button" className="cs-link" onClick={() => toggle(keys, false)}>
                      {t("ap.selectNone")}
                    </button>
                  </>
                ) : null}
              </span>
            </div>
            <div className="cs-table-wrap">
              <table className="cs-table">
                <thead>
                  <tr>
                    {selectable ? (
                      <th className="cs-check">
                        <input
                          type="checkbox"
                          aria-label={t("ap.selectEvery", { group: group.title })}
                          checked={picked === keys.length}
                          onChange={(e) => toggle(keys, e.currentTarget.checked)}
                        />
                      </th>
                    ) : null}
                    <th>{t("ap.colOffer")}</th>
                    {pending ? <th className="cs-num">{t("ap.colNow")}</th> : null}
                    <th className="cs-num">{t(pending ? "ap.colAfter" : "ap.colSetTo")}</th>
                    {pending ? <th className="cs-num">{t("ap.colChange")}</th> : null}
                  </tr>
                </thead>
                {toUnits(group.rows, t("ap.varies")).map((unit) =>
                  unit.model === null ? (
                    <tbody key={unit.rows[0]!.key}>
                      <tr className={unit.flagged ? "cs-flagged" : undefined}>
                        <RowCells row={unit.rows[0]!} cols={cols} />
                      </tr>
                    </tbody>
                  ) : (
                    <ModelUnit key={unit.model} unit={unit} cols={cols} />
                  ),
                )}
              </table>
            </div>
          </div>
        );
      })}
      <div className="cs-foot">
        <span>
          {pending && canApprove
            ? t("ap.selectedOf", { n: selected.size, total: allKeys.length })
            : footNote}
        </span>
        <DecisionButtons
          id={id}
          canApprove={canApprove}
          pending={pending}
          selected={[...selected]}
          total={allKeys.length}
        />
      </div>
    </>
  );
}
