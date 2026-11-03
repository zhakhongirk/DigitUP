import { describe, expect, it } from "vitest";
import {
  buildOps,
  buildPlan,
  codeOf,
  importReason,
  normalizeTitle,
  planIsEmpty,
  readPriceList,
  runReimport,
  type ExistingOffer,
  type ImportedOffer,
} from "@/server/owner/reimport";
import { createApprovalsService } from "@/server/services/approvals";
import { createCatalogService } from "@/server/services/catalog";
import { ServiceError } from "@/server/services/context";
import type { BusinessModelInput } from "@/shared/business-model";
import { createTestTenant, recordingEvents, testDb } from "../helpers/db";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function existing(n: number, overrides: Partial<ExistingOffer> = {}): ExistingOffer {
  return {
    id: id(n),
    title: `Item ${n}`,
    price: 100,
    currency: "KZT",
    attributes: {},
    offerTypeKey: "item",
    ...overrides,
  };
}

function row(title: string, overrides: Partial<ImportedOffer> = {}): ImportedOffer {
  return {
    title,
    description: "",
    category: null,
    offer_type: "product",
    attributes: {},
    price: 100,
    currency: "KZT",
    price_status: "confirmed",
    availability: "unknown",
    image_url: null,
    ...overrides,
  };
}

const csv = (text: string) => new TextEncoder().encode(text);

describe("normalizeTitle", () => {
  it("ignores case, punctuation and spacing", () => {
    expect(normalizeTitle("  Leather  BOOTS, (black) ")).toBe("leather boots black");
    expect(normalizeTitle("Ботинки-Кожа")).toBe("ботинки кожа");
  });
});

describe("codeOf", () => {
  it("reads known code attributes", () => {
    expect(codeOf({ sku: " AB-1 " })).toBe("ab-1");
    expect(codeOf({ code: 42 })).toBe("42");
    expect(codeOf({ color: "red" })).toBeNull();
    expect(codeOf({ sku: "  " })).toBeNull();
    expect(codeOf(null)).toBeNull();
  });
});

describe("buildPlan", () => {
  it("reports an unchanged catalog as empty", () => {
    const plan = buildPlan([existing(1), existing(2)], [row("item 1"), row("ITEM 2")]);
    expect(planIsEmpty(plan)).toBe(true);
    expect(plan.unchanged).toBe(2);
    expect(plan.missing).toEqual([]);
  });

  it("detects price and currency changes by normalized title", () => {
    const plan = buildPlan(
      [existing(1), existing(2)],
      [row("Item 1", { price: 120 }), row("Item 2", { currency: "USD" })],
    );
    expect(plan.priceChanges).toEqual([
      {
        offerId: id(1),
        title: "Item 1",
        before: 100,
        beforeCurrency: "KZT",
        after: 120,
        currency: "KZT",
      },
      {
        offerId: id(2),
        title: "Item 2",
        before: 100,
        beforeCurrency: "KZT",
        after: 100,
        currency: "USD",
      },
    ]);
  });

  it("prefers the code over the title", () => {
    const plan = buildPlan(
      [existing(1, { title: "Old name", attributes: { sku: "A1" } })],
      [row("Renamed", { price: 150, attributes: { sku: "a1" } })],
    );
    expect(plan.priceChanges).toHaveLength(1);
    expect(plan.priceChanges[0]?.offerId).toBe(id(1));
    expect(plan.newOffers).toEqual([]);
    expect(plan.missing).toEqual([]);
  });

  it("falls back to the title when the code is unknown", () => {
    const plan = buildPlan(
      [existing(1, { attributes: { sku: "A1" } })],
      [row("Item 1", { price: 90, attributes: { sku: "ZZ" } })],
    );
    expect(plan.priceChanges).toHaveLength(1);
    expect(plan.newOffers).toEqual([]);
  });

  it("collects new offers and missing offers without deleting", () => {
    const plan = buildPlan(
      [existing(1), existing(2)],
      [row("Item 1"), row("Brand new", { price: 5 })],
    );
    expect(plan.newOffers.map((o) => o.title)).toEqual(["Brand new"]);
    expect(plan.missing).toEqual([{ id: id(2), title: "Item 2" }]);
    expect(buildOps(plan, "item").map((op) => op.op)).toEqual(["upsert_offers"]);
  });

  it("ignores rows without a price for matched offers", () => {
    const plan = buildPlan(
      [existing(1)],
      [row("Item 1", { price: null, currency: null, price_status: "on_request" })],
    );
    expect(planIsEmpty(plan)).toBe(true);
    expect(plan.unchanged).toBe(1);
  });

  it("treats a first price for an unpriced offer as a change", () => {
    const plan = buildPlan([existing(1, { price: null, currency: null })], [row("Item 1")]);
    expect(plan.priceChanges[0]).toMatchObject({ before: null, after: 100 });
  });

  it("skips duplicate rows and blank titles", () => {
    const plan = buildPlan(
      [existing(1)],
      [
        row("Item 1", { price: 110 }),
        row("item 1", { price: 130 }),
        row("  "),
        row("Fresh"),
        row("fresh"),
      ],
    );
    expect(plan.priceChanges).toHaveLength(1);
    expect(plan.priceChanges[0]?.after).toBe(110);
    expect(plan.newOffers).toHaveLength(1);
    expect(plan.skipped).toBe(3);
  });

  it("does not guess between catalog offers sharing a title", () => {
    const plan = buildPlan(
      [existing(1, { title: "Twin" }), existing(2, { title: "Twin" })],
      [row("Twin", { price: 1 })],
    );
    expect(plan.priceChanges).toEqual([]);
    expect(plan.newOffers).toEqual([]);
    expect(plan.skipped).toBe(1);
    expect(plan.missing).toHaveLength(2);
  });
});

describe("archived offers", () => {
  it("matches archived offers and plans a restore instead of a duplicate", () => {
    const plan = buildPlan(
      [existing(1, { status: "archived", price: 100 }), existing(2)],
      [row("Item 1", { price: 130 }), row("Item 2")],
    );
    expect(plan.newOffers).toEqual([]);
    expect(plan.priceChanges).toEqual([]);
    expect(plan.restored).toHaveLength(1);
    expect(plan.restored[0]).toMatchObject({ offer: { id: id(1) }, price: 130, currency: "KZT" });
    expect(plan.missing).toEqual([]);
    expect(planIsEmpty(plan)).toBe(false);
    expect(buildOps(plan, "item")[0]).toMatchObject({
      op: "upsert_offers",
      offers: [{ id: id(1), status: "active", price: 130, price_status: "confirmed" }],
    });
  });

  it("does not list archived offers as missing", () => {
    const plan = buildPlan([existing(1, { status: "archived" })], [row("Other")]);
    expect(plan.missing).toEqual([]);
  });
});

describe("buildOps codes", () => {
  it("keeps only code attributes the offer type defines", () => {
    const plan = buildPlan([], [row("Fresh", { attributes: { sku: "A1", color: "red" } })]);
    const [op] = buildOps(plan, "item", new Set(["sku"]));
    expect(op).toMatchObject({ offers: [{ attributes: { sku: "A1" } }] });
    const [bare] = buildOps(plan, "item");
    expect(bare).toMatchObject({ offers: [{ attributes: {} }] });
  });
});

describe("buildOps", () => {
  it("builds update_prices and upsert_offers with the catalog offer type", () => {
    const plan = buildPlan(
      [existing(1)],
      [
        row("Item 1", { price: 7, attributes: { sku: "x" } }),
        row("Fresh", { price: 9, category: "Shoes" }),
      ],
    );
    const ops = buildOps(plan, "item");
    expect(ops[0]).toEqual({
      op: "update_prices",
      items: [{ offerId: id(1), price: 7, currency: "KZT" }],
    });
    expect(ops[1]).toMatchObject({
      op: "upsert_offers",
      offers: [{ title: "Fresh", offer_type: "item", attributes: {}, category: "Shoes", price: 9 }],
    });
  });

  it("splits large lists into several operations", () => {
    const imported = Array.from({ length: 501 }, (_, n) => row(`New ${n}`));
    const ops = buildOps(buildPlan([], imported), "item");
    expect(ops.map((op) => (op.op === "upsert_offers" ? op.offers.length : 0))).toEqual([500, 1]);
  });
});

describe("importReason", () => {
  it("uses the base file name", () => {
    expect(importReason("C:\\docs\\prices.xlsx")).toBe("Price list import: prices.xlsx");
  });
});

describe("readPriceList", () => {
  it("rejects unsupported and empty files", async () => {
    await expect(readPriceList("a.png", csv("x"), null)).rejects.toBeInstanceOf(ServiceError);
    await expect(readPriceList("a.csv", new Uint8Array(0), null)).rejects.toBeInstanceOf(
      ServiceError,
    );
  });

  it("rejects files without a price table", async () => {
    await expect(readPriceList("a.csv", csv("hello\nworld"), null)).rejects.toThrow(/price table/);
  });

  it("uses the catalog currency when the file has none", async () => {
    const offers = await readPriceList("a.csv", csv("Name,Price\nBoots,5000\n"), "KZT");
    expect(offers[0]).toMatchObject({ title: "Boots", price: 5000, currency: "KZT" });
  });
});

const model: BusinessModelInput = {
  profile: { name: "Shop" },
  offer_types: [{ key: "item", name: "Item", kind: "product", attributes: [] }],
  offers: [
    { title: "Alpha", offer_type: "item", price: 100, currency: "KZT", price_status: "confirmed" },
    { title: "Beta", offer_type: "item", price: 200, currency: "KZT", price_status: "confirmed" },
    { title: "Gamma", offer_type: "item", price: 300, currency: "KZT", price_status: "confirmed" },
  ],
};

describe("runReimport", () => {
  async function setup() {
    const db = testDb();
    const owner = await createTestTenant({ actor: "owner" });
    const catalog = createCatalogService({ db, events: recordingEvents() });
    const approvals = createApprovalsService(db);
    await catalog.applyBusinessModel(owner, model);
    return { owner, catalog, approvals };
  }

  it("creates one pending change set from a CSV", async () => {
    const { owner, catalog, approvals } = await setup();
    const result = await runReimport({ catalog, approvals }, owner, {
      filename: "prices.csv",
      bytes: csv("Name,Price\nAlpha,120\nbeta,200\nDelta,50\n"),
    });
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.plan.missing.map((o) => o.title)).toEqual(["Gamma"]);

    const sets = await approvals.listChangeSets(owner);
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({
      id: result.changeSetId,
      status: "pending",
      requestedBy: "owner",
      reason: "Price list import: prices.csv",
    });
    const ops = sets[0]!.ops as { op: string }[];
    expect(ops.map((op) => op.op)).toEqual(["update_prices", "upsert_offers"]);

    await approvals.approveChangeSet(owner, result.changeSetId);
    const { items } = await catalog.searchOffers(owner, { limit: 100 });
    const prices = Object.fromEntries(items.map((o) => [o.title, o.price]));
    expect(prices).toMatchObject({ Alpha: 120, Beta: 200, Gamma: 300, Delta: 50 });
  });

  it("creates nothing when the file matches the catalog", async () => {
    const { owner, catalog, approvals } = await setup();
    const result = await runReimport({ catalog, approvals }, owner, {
      filename: "prices.csv",
      bytes: csv("Name,Price\nAlpha,100\nBeta,200\n"),
    });
    expect(result.status).toBe("unchanged");
    expect(result.plan.missing.map((o) => o.title)).toEqual(["Gamma"]);
    expect(await approvals.listChangeSets(owner)).toHaveLength(0);
  });

  it("restores an archived offer from the file and keeps the sku", async () => {
    const db = testDb();
    const owner = await createTestTenant({ actor: "owner" });
    const catalog = createCatalogService({ db, events: recordingEvents() });
    const approvals = createApprovalsService(db);
    await catalog.applyBusinessModel(owner, {
      ...model,
      offer_types: [
        {
          key: "item",
          name: "Item",
          kind: "product",
          attributes: [{ key: "sku", label: "SKU", type: "text", required: false }],
        },
      ],
    });
    const { items } = await catalog.searchOffers(owner, { limit: 100 });
    const gamma = items.find((o) => o.title === "Gamma")!;
    await catalog.archiveOffers(owner, [gamma.id]);

    const result = await runReimport({ catalog, approvals }, owner, {
      filename: "prices.csv",
      bytes: csv("Name,Price,SKU\nGamma,350,\nDelta,50,D-1\n"),
    });
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.plan.restored.map((r) => r.offer.title)).toEqual(["Gamma"]);
    expect(result.plan.missing.map((o) => o.title).sort()).toEqual(["Alpha", "Beta"]);

    await approvals.approveChangeSet(owner, result.changeSetId);
    const after = await catalog.searchOffers(owner, {
      statuses: ["active", "archived"],
      limit: 100,
    });
    const gammas = after.items.filter((o) => o.title === "Gamma");
    expect(gammas).toHaveLength(1);
    expect(gammas[0]).toMatchObject({ status: "active", price: 350 });
    expect(after.items.find((o) => o.title === "Delta")?.attributes).toEqual({ sku: "D-1" });
  });
});
