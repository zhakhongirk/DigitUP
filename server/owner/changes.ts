import { z } from "zod";
import type { Services } from "@/server/container";
import { changeSetOpSchema, type ChangeSet, type ChangeSetOp } from "@/server/services/approvals";
import type { OfferView } from "@/server/services/catalog";
import type { TenantContext } from "@/server/services/context";
import { formatPrice } from "@/shared/format";

export const CHANGE_STATUS_LABELS: Record<ChangeSet["status"], string> = {
  pending: "Pending",
  applied: "Applied",
  rejected: "Rejected",
};

const OP_TITLES: Record<ChangeSetOp["op"], string> = {
  update_prices: "Price changes",
  delete_offers: "Offers to remove",
  upsert_offers: "New and edited offers",
};

/** Price moves above this share are highlighted for a second look. */
export const BIG_CHANGE = 0.1;

export interface ChangeRow {
  key: string;
  title: string;
  before: string | null;
  after: string;
  delta: string | null;
  flagged: boolean;
}

export interface ChangeGroup {
  op: ChangeSetOp["op"];
  title: string;
  rows: ChangeRow[];
}

export interface ChangeSetView {
  id: string;
  status: ChangeSet["status"];
  statusLabel: string;
  requestedBy: string;
  reason: string;
  createdAt: Date;
  resolvedAt: Date | null;
  summary: string;
  groups: ChangeGroup[];
  flagged: string[];
  invalid: boolean;
}

const REQUESTERS: Record<ChangeSet["requestedBy"], string> = {
  owner: "You",
  business_agent: "Business agent",
  customer_agent: "Customer agent",
  system: "System",
};

function priceText(price: number | null, currency: string | null | undefined): string {
  return price === null ? "On request" : formatPrice(price, currency);
}

function delta(before: number | null, after: number | null): { text: string | null; big: boolean } {
  if (after === null) return { text: before === null ? null : "Price removed", big: false };
  if (before === null) return { text: "Newly priced", big: false };
  if (before === 0) return { text: after === 0 ? "No change" : "From zero", big: after !== 0 };
  const share = (after - before) / before;
  if (share === 0) return { text: "No change", big: false };
  const sign = share > 0 ? "+" : "-";
  return {
    text: `${sign}${(Math.abs(share) * 100).toFixed(1)}%`,
    big: Math.abs(share) > BIG_CHANGE,
  };
}

export function parseOps(raw: unknown): ChangeSetOp[] | null {
  const parsed = z.array(changeSetOpSchema).safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function offerIdsOf(ops: ChangeSetOp[]): string[] {
  const ids = new Set<string>();
  for (const op of ops) {
    if (op.op === "update_prices") op.items.forEach((item) => ids.add(item.offerId));
    if (op.op === "delete_offers") op.offerIds.forEach((id) => ids.add(id));
    if (op.op === "upsert_offers") op.offers.forEach((offer) => offer.id && ids.add(offer.id));
  }
  return [...ids];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function summarize(ops: ChangeSetOp[]): string {
  return ops
    .map((op) => {
      if (op.op === "update_prices") return `${plural(op.items.length, "price")} changed`;
      if (op.op === "delete_offers") return `${plural(op.offerIds.length, "offer")} removed`;
      return `${plural(op.offers.length, "offer")} added or edited`;
    })
    .join(", ");
}

/**
 * Rows for each operation. "Before" is the live catalog value, so it is only
 * meaningful while the change set is pending.
 */
export function describeChangeSet(
  changeSet: ChangeSet,
  offers: ReadonlyMap<string, Pick<OfferView, "title" | "price" | "currency" | "status">>,
): ChangeSetView {
  const ops = parseOps(changeSet.ops);
  const pending = changeSet.status === "pending";
  const groups: ChangeGroup[] = [];
  const flagged: string[] = [];

  for (const [index, op] of (ops ?? []).entries()) {
    const rows: ChangeRow[] = [];
    if (op.op === "update_prices") {
      for (const item of op.items) {
        const offer = offers.get(item.offerId);
        const currency = item.currency ?? offer?.currency;
        const change =
          pending && offer ? delta(offer.price, item.price) : { text: null, big: false };
        const title = offer?.title ?? "Unknown offer";
        if (change.big) flagged.push(title);
        rows.push({
          key: `${index}:${item.offerId}`,
          title,
          before: pending && offer ? priceText(offer.price, offer.currency) : null,
          after: priceText(item.price, currency),
          delta: change.text,
          flagged: change.big,
        });
      }
    } else if (op.op === "delete_offers") {
      for (const id of op.offerIds) {
        const offer = offers.get(id);
        rows.push({
          key: `${index}:${id}`,
          title: offer?.title ?? "Unknown offer",
          before: pending && offer ? priceText(offer.price, offer.currency) : null,
          after: "Removed",
          delta: null,
          flagged: false,
        });
      }
    } else {
      for (const [n, item] of op.offers.entries()) {
        const existing = item.id ? offers.get(item.id) : undefined;
        const price = item.price ?? null;
        const change =
          pending && existing ? delta(existing.price, price) : { text: null, big: false };
        if (change.big) flagged.push(item.title);
        rows.push({
          key: `${index}:${item.id ?? n}`,
          title: item.title,
          before: !item.id
            ? "New offer"
            : pending && existing
              ? priceText(existing.price, existing.currency)
              : null,
          after: priceText(price, item.currency ?? existing?.currency),
          delta: change.text,
          flagged: change.big,
        });
      }
    }
    groups.push({ op: op.op, title: OP_TITLES[op.op], rows });
  }

  return {
    id: changeSet.id,
    status: changeSet.status,
    statusLabel: CHANGE_STATUS_LABELS[changeSet.status],
    requestedBy: REQUESTERS[changeSet.requestedBy],
    reason: changeSet.reason,
    createdAt: changeSet.createdAt,
    resolvedAt: changeSet.resolvedAt,
    summary: ops ? summarize(ops) : "Unreadable change set",
    groups,
    flagged,
    invalid: ops === null,
  };
}

export interface ChangesPage {
  list: { id: string; status: ChangeSet["status"]; summary: string; createdAt: Date }[];
  selected: ChangeSetView | null;
}

export async function loadChanges(
  services: Services,
  ctx: TenantContext,
  selectedId?: string,
): Promise<ChangesPage> {
  const all = await services.approvals.listChangeSets(ctx, { limit: 100 });
  const list = all.map((cs) => {
    const ops = parseOps(cs.ops);
    return {
      id: cs.id,
      status: cs.status,
      summary: ops ? summarize(ops) : "Unreadable change set",
      createdAt: cs.createdAt,
    };
  });
  const chosen =
    all.find((cs) => cs.id === selectedId) ?? all.find((cs) => cs.status === "pending") ?? all[0];
  if (!chosen) return { list, selected: null };

  const ids = offerIdsOf(parseOps(chosen.ops) ?? []);
  const offers = await services.catalog.getOffers(ctx, ids);
  return {
    list,
    selected: describeChangeSet(chosen, new Map(offers.map((offer) => [offer.id, offer]))),
  };
}

export async function pendingChangeCount(services: Services, ctx: TenantContext): Promise<number> {
  return (await services.approvals.listChangeSets(ctx, { status: "pending", limit: 200 })).length;
}
