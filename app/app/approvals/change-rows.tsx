"use client";

import { useState } from "react";
import type { ChangeGroup } from "@/server/owner/changes";
import { DecisionButtons } from "./decision-buttons";

function deltaClass(delta: string | null): string {
  if (!delta) return "";
  if (delta === "Newly priced") return " cs-delta-new";
  if (delta.startsWith("+")) return " cs-delta-up";
  if (delta.startsWith("-")) return " cs-delta-down";
  return "";
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
                {group.rows.length} {group.rows.length === 1 ? "offer" : "offers"}
                {selectable ? (
                  <>
                    {" · "}
                    <button type="button" className="cs-link" onClick={() => toggle(keys, true)}>
                      Select all
                    </button>
                    {" · "}
                    <button type="button" className="cs-link" onClick={() => toggle(keys, false)}>
                      Select none
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
                          aria-label={`Select every row in ${group.title}`}
                          checked={picked === keys.length}
                          onChange={(e) => toggle(keys, e.currentTarget.checked)}
                        />
                      </th>
                    ) : null}
                    <th>Offer</th>
                    {pending ? <th className="cs-num">Now</th> : null}
                    <th className="cs-num">{pending ? "After" : "Set to"}</th>
                    {pending ? <th className="cs-num">Change</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((row) => (
                    <tr key={row.key} className={row.flagged ? "cs-flagged" : undefined}>
                      {selectable ? (
                        <td className="cs-check">
                          <input
                            type="checkbox"
                            aria-label={`Apply ${row.title}`}
                            checked={selected.has(row.key)}
                            onChange={(e) => toggle([row.key], e.currentTarget.checked)}
                          />
                        </td>
                      ) : null}
                      <td>{row.title}</td>
                      {pending ? (
                        <td
                          className={`cs-num cs-before${row.before === "On request" ? " cs-before-none" : ""}`}
                        >
                          {row.before ?? ""}
                        </td>
                      ) : null}
                      <td className="cs-num cs-after">{row.after}</td>
                      {pending ? (
                        <td className={`cs-num cs-delta${deltaClass(row.delta)}`}>
                          {row.delta ?? ""}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
      <div className="cs-foot">
        <span>
          {pending && canApprove
            ? `${selected.size} of ${allKeys.length} selected. Unselected changes are dropped.`
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
