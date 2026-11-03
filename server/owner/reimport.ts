import type { ApprovalsService, ChangeSetOp } from "@/server/services/approvals";
import type { CatalogService, OfferView } from "@/server/services/catalog";
import { ServiceError, type TenantContext } from "@/server/services/context";
import { detectKind, extractText, ExtractionError } from "@/server/services/ingestion/extract";
import { importBusinessModel } from "@/server/services/onboarding/import";
import type { BusinessModelInput } from "@/shared/business-model";

export type ImportedOffer = NonNullable<BusinessModelInput["offers"]>[number];
type Attributes = NonNullable<ImportedOffer["attributes"]>;

export type ExistingOffer = Pick<
  OfferView,
  "id" | "title" | "price" | "currency" | "attributes" | "offerTypeKey"
> &
  Partial<
    Pick<
      OfferView,
      "status" | "description" | "category" | "priceStatus" | "availability" | "imageUrl"
    >
  >;

export interface RestoredOffer {
  offer: ExistingOffer;
  price: number | null;
  currency: string | null;
}

export interface PriceChange {
  offerId: string;
  title: string;
  before: number | null;
  beforeCurrency: string | null;
  after: number;
  currency: string;
}

export interface ReimportPlan {
  priceChanges: PriceChange[];
  newOffers: ImportedOffer[];
  /** Archived offers found in the file; approving brings them back as active. */
  restored: RestoredOffer[];
  missing: { id: string; title: string }[];
  unchanged: number;
  skipped: number;
}

const MAX_OPS_ITEMS = 500;
const CODE_KEYS = ["sku", "code", "article", "item_code", "product_code", "vendor_code"];

export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function codeOf(attributes: unknown): string | null {
  if (!attributes || typeof attributes !== "object") return null;
  const record = attributes as Record<string, unknown>;
  for (const key of CODE_KEYS) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") {
      const code = String(value).trim().toLowerCase();
      if (code !== "") return code;
    }
  }
  return null;
}

function addUnique(map: Map<string, ExistingOffer | null>, key: string, offer: ExistingOffer) {
  map.set(key, map.has(key) ? null : offer);
}

export function buildPlan(
  existing: readonly ExistingOffer[],
  imported: readonly ImportedOffer[],
): ReimportPlan {
  const byCode = new Map<string, ExistingOffer | null>();
  const byTitle = new Map<string, ExistingOffer | null>();
  for (const offer of existing) {
    const code = codeOf(offer.attributes);
    if (code) addUnique(byCode, code, offer);
    const title = normalizeTitle(offer.title);
    if (title) addUnique(byTitle, title, offer);
  }

  const matched = new Set<string>();
  const priceChanges: PriceChange[] = [];
  const newOffers: ImportedOffer[] = [];
  const restored: RestoredOffer[] = [];
  const seenNew = new Set<string>();
  let unchanged = 0;
  let skipped = 0;

  for (const row of imported) {
    const title = normalizeTitle(row.title);
    if (!title) {
      skipped++;
      continue;
    }
    const code = codeOf(row.attributes);
    const found = (code ? byCode.get(code) : undefined) ?? byTitle.get(title) ?? null;

    if (!found) {
      const ambiguous = (code !== null && byCode.has(code)) || byTitle.has(title);
      const key = code ? `code:${code}` : `title:${title}`;
      if (ambiguous || seenNew.has(key)) {
        skipped++;
        continue;
      }
      seenNew.add(key);
      newOffers.push(row);
      continue;
    }
    if (matched.has(found.id)) {
      skipped++;
      continue;
    }
    matched.add(found.id);

    const price = row.price ?? null;
    const currency = row.currency ?? null;
    if (found.status === "archived") {
      const priced = price !== null && currency !== null;
      restored.push({
        offer: found,
        price: priced ? price : found.price,
        currency: priced ? currency : found.currency,
      });
      continue;
    }
    if (
      price === null ||
      currency === null ||
      (found.price === price && found.currency === currency)
    ) {
      unchanged++;
      continue;
    }
    priceChanges.push({
      offerId: found.id,
      title: found.title,
      before: found.price,
      beforeCurrency: found.currency,
      after: price,
      currency,
    });
  }

  const missing = existing
    .filter((offer) => offer.status !== "archived" && !matched.has(offer.id))
    .map((offer) => ({ id: offer.id, title: offer.title }));

  return { priceChanges, newOffers, restored, missing, unchanged, skipped };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function planIsEmpty(plan: ReimportPlan): boolean {
  return (
    plan.priceChanges.length === 0 && plan.newOffers.length === 0 && plan.restored.length === 0
  );
}

function mostCommon(values: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function keptCodes(
  attributes: ImportedOffer["attributes"],
  codeKeys: ReadonlySet<string>,
): Attributes {
  const kept: Attributes = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (codeKeys.has(key) && typeof value === "string") kept[key] = value;
  }
  return kept;
}

export function buildOps(
  plan: ReimportPlan,
  offerTypeKey: string,
  codeKeys: ReadonlySet<string> = new Set(),
): ChangeSetOp[] {
  const ops: ChangeSetOp[] = [];
  for (const items of chunk(plan.priceChanges, MAX_OPS_ITEMS)) {
    ops.push({
      op: "update_prices",
      items: items.map((item) => ({
        offerId: item.offerId,
        price: item.after,
        currency: item.currency,
      })),
    });
  }
  for (const offers of chunk(plan.newOffers, MAX_OPS_ITEMS)) {
    ops.push({
      op: "upsert_offers",
      offers: offers.map((offer) => ({
        title: offer.title,
        description: offer.description ?? "",
        category: offer.category ?? null,
        offer_type: offerTypeKey,
        attributes: keptCodes(offer.attributes, codeKeys),
        status: "active" as const,
        price: offer.price ?? null,
        currency: offer.currency ?? null,
        price_status: offer.price_status,
        availability: offer.availability ?? "unknown",
        image_url: offer.image_url ?? null,
      })),
    });
  }
  for (const items of chunk(plan.restored, MAX_OPS_ITEMS)) {
    ops.push({
      op: "upsert_offers",
      offers: items.map(({ offer, price, currency }) => ({
        id: offer.id,
        title: offer.title,
        description: offer.description ?? "",
        category: offer.category ?? null,
        offer_type: offer.offerTypeKey,
        attributes: (offer.attributes ?? {}) as Attributes,
        status: "active" as const,
        price,
        currency,
        price_status: price !== null ? ("confirmed" as const) : (offer.priceStatus ?? "on_request"),
        availability: offer.availability ?? "unknown",
        image_url: offer.imageUrl ?? null,
      })),
    });
  }
  return ops;
}

export function importReason(filename: string): string {
  const name = filename.split(/[\\/]/).pop()!.trim().slice(0, 200);
  return `Price list import: ${name}`;
}

export async function readPriceList(
  filename: string,
  bytes: Uint8Array,
  currencyHint: string | null,
): Promise<ImportedOffer[]> {
  const kind = detectKind(filename);
  if (!kind || kind === "txt") {
    throw new ServiceError("invalid", "Use an XLSX, CSV, PDF or DOCX file");
  }
  if (bytes.byteLength === 0) throw new ServiceError("invalid", "The file is empty");
  let extraction;
  try {
    extraction = await extractText(kind, bytes);
  } catch (error) {
    if (error instanceof ExtractionError) throw new ServiceError("invalid", error.message);
    throw error;
  }
  const texts = [extraction.text, ...(currencyHint ? [`Currency: ${currencyHint}`] : [])];
  const model = importBusinessModel({ businessName: "Import", texts, tables: extraction.tables });
  const offers = model.offers ?? [];
  if (offers.length === 0) {
    throw new ServiceError(
      "invalid",
      "We could not find a price table in this file. Check that it has a name column and a price column.",
    );
  }
  return offers;
}

export async function loadExistingOffers(
  catalog: Pick<CatalogService, "searchOffers">,
  ctx: TenantContext,
): Promise<OfferView[]> {
  const all: OfferView[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await catalog.searchOffers(ctx, {
      statuses: ["active", "draft", "archived"],
      limit: 100,
      offset,
    });
    all.push(...page.items);
    if (all.length >= page.total || page.items.length === 0) return all;
  }
}

export type ReimportResult =
  | { status: "created"; changeSetId: string; plan: ReimportPlan }
  | { status: "unchanged"; plan: ReimportPlan };

export async function runReimport(
  services: {
    catalog: Pick<CatalogService, "searchOffers" | "listOfferTypes">;
    approvals: ApprovalsService;
  },
  ctx: TenantContext,
  file: { filename: string; bytes: Uint8Array },
): Promise<ReimportResult> {
  const existing = await loadExistingOffers(services.catalog, ctx);
  const currencyHint = mostCommon(existing.flatMap((o) => (o.currency ? [o.currency] : [])));
  const imported = await readPriceList(file.filename, file.bytes, currencyHint);
  const plan = buildPlan(existing, imported);
  if (planIsEmpty(plan)) return { status: "unchanged", plan };

  const typeKey = mostCommon(existing.map((o) => o.offerTypeKey));
  if (plan.newOffers.length > 0 && !typeKey) {
    throw new ServiceError("invalid", "Set up your business model before importing new offers");
  }
  const types = plan.newOffers.length > 0 ? await services.catalog.listOfferTypes(ctx) : [];
  const type = types.find((t) => t.key === typeKey);
  const defined = new Set(
    ((type?.attributeSchema ?? []) as { key: string; type: string }[])
      .filter((attr) => attr.type === "text")
      .map((attr) => attr.key),
  );
  const codeKeys = new Set(CODE_KEYS.filter((key) => defined.has(key)));
  const changeSet = await services.approvals.createChangeSet(ctx, {
    ops: buildOps(plan, typeKey ?? "", codeKeys),
    reason: importReason(file.filename),
  });
  return { status: "created", changeSetId: changeSet.id, plan };
}
