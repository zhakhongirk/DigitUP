import { z } from "zod";
import type { Services } from "@/server/container";
import { changeSetOpSchema, type ChangeSet, type ChangeSetOp } from "@/server/services/approvals";
import type { OfferView } from "@/server/services/catalog";
import type { TenantContext } from "@/server/services/context";
import type { Lang } from "@/server/storefront/i18n";
import { formatPrice } from "@/shared/format";
import { tr, trn, type TextKey } from "@/shared/owner-copy";

export const CHANGE_STATUS_LABELS: Record<ChangeSet["status"], string> = {
  pending: "Pending",
  applied: "Applied",
  rejected: "Rejected",
};

const STATUS_KEYS: Record<ChangeSet["status"], TextKey> = {
  pending: "ap.statusPending",
  applied: "ap.statusApplied",
  rejected: "ap.statusRejected",
};

export function changeStatusLabel(lang: Lang, status: ChangeSet["status"]): string {
  return tr(lang, STATUS_KEYS[status]);
}

const OP_TITLE_KEYS: Record<ChangeSetOp["op"], TextKey> = {
  update_prices: "ap.opPrices",
  delete_offers: "ap.opDelete",
  upsert_offers: "ap.opUpsert",
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

const REQUESTER_KEYS: Record<ChangeSet["requestedBy"], TextKey> = {
  owner: "common.you",
  business_agent: "common.businessAgent",
  customer_agent: "common.customerAgent",
  system: "common.system",
};

function priceText(price: number | null, currency: string | null | undefined, lang: Lang): string {
  return price === null ? tr(lang, "common.onRequest") : formatPrice(price, currency, lang);
}

function delta(
  before: number | null,
  after: number | null,
  lang: Lang,
): { text: string | null; big: boolean } {
  if (after === null) {
    return { text: before === null ? null : tr(lang, "ap.priceRemoved"), big: false };
  }
  if (before === null) return { text: tr(lang, "ap.newlyPriced"), big: false };
  if (before === 0) {
    return {
      text: tr(lang, after === 0 ? "ap.noChange" : "ap.fromZero"),
      big: after !== 0,
    };
  }
  const share = (after - before) / before;
  if (share === 0) return { text: tr(lang, "ap.noChange"), big: false };
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

export function summarize(ops: ChangeSetOp[], lang: Lang = "en"): string {
  return ops
    .map((op) => {
      if (op.op === "update_prices") return trn(lang, "ap.sumPrices", op.items.length);
      if (op.op === "delete_offers") return trn(lang, "ap.sumRemoved", op.offerIds.length);
      return trn(lang, "ap.sumEdited", op.offers.length);
    })
    .join(", ");
}

/**
 * Rows for each operation. "Before" is the live catalog value, so it is only
 * meaningful while the approval is pending.
 */
export function describeChangeSet(
  changeSet: ChangeSet,
  offers: ReadonlyMap<string, Pick<OfferView, "title" | "price" | "currency" | "status">>,
  lang: Lang = "en",
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
          pending && offer ? delta(offer.price, item.price, lang) : { text: null, big: false };
        const title = offer?.title ?? tr(lang, "ap.unknownOffer");
        if (change.big) flagged.push(title);
        rows.push({
          key: `${index}:${rows.length}`,
          title,
          before: pending && offer ? priceText(offer.price, offer.currency, lang) : null,
          after: priceText(item.price, currency, lang),
          delta: change.text,
          flagged: change.big,
        });
      }
    } else if (op.op === "delete_offers") {
      for (const id of op.offerIds) {
        const offer = offers.get(id);
        rows.push({
          key: `${index}:${rows.length}`,
          title: offer?.title ?? tr(lang, "ap.unknownOffer"),
          before: pending && offer ? priceText(offer.price, offer.currency, lang) : null,
          after: tr(lang, "ap.removed"),
          delta: null,
          flagged: false,
        });
      }
    } else {
      for (const [n, item] of op.offers.entries()) {
        const existing = item.id ? offers.get(item.id) : undefined;
        const price = item.price ?? null;
        const change =
          pending && existing ? delta(existing.price, price, lang) : { text: null, big: false };
        if (change.big) flagged.push(item.title);
        rows.push({
          key: `${index}:${n}`,
          title: item.title,
          before: !item.id
            ? tr(lang, "ap.newOffer")
            : pending && existing
              ? priceText(existing.price, existing.currency, lang)
              : null,
          after: priceText(price, item.currency ?? existing?.currency, lang),
          delta: change.text,
          flagged: change.big,
        });
      }
    }
    groups.push({ op: op.op, title: tr(lang, OP_TITLE_KEYS[op.op]), rows });
  }

  return {
    id: changeSet.id,
    status: changeSet.status,
    statusLabel: changeStatusLabel(lang, changeSet.status),
    requestedBy: tr(lang, REQUESTER_KEYS[changeSet.requestedBy]),
    reason: changeSet.reason,
    createdAt: changeSet.createdAt,
    resolvedAt: changeSet.resolvedAt,
    summary: ops ? summarize(ops, lang) : tr(lang, "ws.unreadable"),
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
  lang: Lang = "en",
): Promise<ChangesPage> {
  const all = await services.approvals.listChangeSets(ctx, { limit: 100 });
  const list = all.map((cs) => {
    const ops = parseOps(cs.ops);
    return {
      id: cs.id,
      status: cs.status,
      summary: ops ? summarize(ops, lang) : tr(lang, "ws.unreadable"),
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
    selected: describeChangeSet(chosen, new Map(offers.map((offer) => [offer.id, offer])), lang),
  };
}

export async function pendingChangeCount(services: Services, ctx: TenantContext): Promise<number> {
  return (await services.approvals.listChangeSets(ctx, { status: "pending", limit: 200 })).length;
}
