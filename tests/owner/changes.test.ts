import { describe, expect, it } from "vitest";
import { describeChangeSet, offerIdsOf, parseOps, summarize } from "@/server/owner/changes";
import type { ChangeSet, ChangeSetOp } from "@/server/services/approvals";

const T0 = new Date("2026-11-02T09:00:00Z");
const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";

type OfferInfo = { title: string; price: number | null; currency: string; status: "active" };

function offers(entries: [string, Partial<OfferInfo>][]) {
  return new Map(
    entries.map(([id, o]) => [
      id,
      { title: "Boots", price: 50000, currency: "KZT", status: "active" as const, ...o },
    ]),
  );
}

function changeSet(ops: unknown, overrides: Partial<ChangeSet> = {}): ChangeSet {
  return {
    id: "cs1",
    tenantId: "t",
    ops,
    reason: "Autumn sale",
    status: "pending",
    requestedBy: "owner",
    createdAt: T0,
    resolvedAt: null,
    ...overrides,
  };
}

function newOffer(overrides: Record<string, unknown> = {}) {
  return {
    title: "Sandals",
    offer_type: "product",
    price: 10000,
    currency: "KZT",
    price_status: "confirmed",
    ...overrides,
  };
}

const prices = (...items: { offerId: string; price: number | null; currency?: string }[]) => [
  { op: "update_prices", items },
];

describe("parseOps", () => {
  it("parses valid ops", () => {
    const raw = [...prices({ offerId: A, price: 100 }), { op: "delete_offers", offerIds: [B] }];
    expect(parseOps(raw)).toHaveLength(2);
  });

  it("returns null for garbage", () => {
    expect(parseOps("nope")).toBeNull();
    expect(parseOps([{ op: "explode" }])).toBeNull();
    expect(parseOps([{ op: "delete_offers", offerIds: ["not-a-uuid"] }])).toBeNull();
  });
});

describe("offerIdsOf", () => {
  it("collects and deduplicates ids, skipping new offers", () => {
    const ops = parseOps([
      ...prices({ offerId: A, price: 1 }, { offerId: B, price: 2 }),
      { op: "delete_offers", offerIds: [B, C] },
      { op: "upsert_offers", offers: [newOffer({ id: A }), newOffer()] },
    ]) as ChangeSetOp[];
    expect(offerIdsOf(ops).sort()).toEqual([A, B, C]);
  });
});

describe("summarize", () => {
  it("joins operations with singular and plural forms", () => {
    const ops = parseOps([
      ...prices({ offerId: A, price: 1 }, { offerId: B, price: 2 }),
      { op: "delete_offers", offerIds: [C] },
      { op: "upsert_offers", offers: [newOffer()] },
    ]) as ChangeSetOp[];
    expect(summarize(ops)).toBe("2 prices changed, 1 offer removed, 1 offer added or edited");
    expect(summarize(ops.slice(0, 1))).toBe("2 prices changed");
  });

  it("pluralises removals", () => {
    const ops = parseOps([{ op: "delete_offers", offerIds: [A, B] }]) as ChangeSetOp[];
    expect(summarize(ops)).toBe("2 offers removed");
  });
});

describe("describeChangeSet: pending price updates", () => {
  it("shows before, after and delta", () => {
    const view = describeChangeSet(
      changeSet(prices({ offerId: A, price: 61000 })),
      offers([[A, { price: 58000 }]]),
    );
    const [row] = view.groups[0]!.rows;
    expect(view.groups[0]!.title).toBe("Price changes");
    expect(row).toMatchObject({
      title: "Boots",
      before: "58 000 ₸",
      after: "61 000 ₸",
      delta: "+5.2%",
      flagged: false,
    });
    expect(view.flagged).toEqual([]);
    expect(view.statusLabel).toBe("Pending");
    expect(view.summary).toBe("1 price changed");
    expect(view.invalid).toBe(false);
  });

  it("flags moves above 10%", () => {
    const view = describeChangeSet(
      changeSet(prices({ offerId: A, price: 40000 })),
      offers([[A, { title: "Parka", price: 50000 }]]),
    );
    expect(view.groups[0]!.rows[0]).toMatchObject({ delta: "-20.0%", flagged: true });
    expect(view.flagged).toEqual(["Parka"]);
  });

  it("marks a first price as newly priced", () => {
    const view = describeChangeSet(
      changeSet(prices({ offerId: A, price: 9000 })),
      offers([[A, { price: null }]]),
    );
    expect(view.groups[0]!.rows[0]).toMatchObject({
      before: "On request",
      delta: "Newly priced",
      flagged: false,
    });
  });

  it("marks a removed price", () => {
    const view = describeChangeSet(
      changeSet(prices({ offerId: A, price: null })),
      offers([[A, { price: 50000 }]]),
    );
    expect(view.groups[0]!.rows[0]).toMatchObject({
      after: "On request",
      delta: "Price removed",
      flagged: false,
    });
  });

  it("handles unknown offers", () => {
    const view = describeChangeSet(changeSet(prices({ offerId: A, price: 100 })), new Map());
    expect(view.groups[0]!.rows[0]).toMatchObject({
      title: "Unknown offer",
      before: null,
      delta: null,
    });
  });

  it("falls back to the offer currency, preferring the item's own", () => {
    const view = describeChangeSet(
      changeSet(prices({ offerId: A, price: 1250 }, { offerId: B, price: 1250, currency: "USD" })),
      offers([
        [A, { currency: "KZT" }],
        [B, { currency: "KZT" }],
      ]),
    );
    const [first, second] = view.groups[0]!.rows;
    expect(first!.after).toBe("1 250 ₸");
    expect(second!.after).toBe("$1 250");
  });
});

describe("describeChangeSet: deletions and upserts", () => {
  it("describes removed offers", () => {
    const view = describeChangeSet(
      changeSet([{ op: "delete_offers", offerIds: [A] }]),
      offers([[A, { price: 58000 }]]),
    );
    expect(view.groups[0]!.title).toBe("Offers to remove");
    expect(view.groups[0]!.rows[0]).toMatchObject({
      title: "Boots",
      before: "58 000 ₸",
      after: "Removed",
      delta: null,
    });
  });

  it("describes new and existing upserts", () => {
    const view = describeChangeSet(
      changeSet([
        {
          op: "upsert_offers",
          offers: [newOffer(), newOffer({ id: A, title: "Boots", price: 55000 })],
        },
      ]),
      offers([[A, { price: 50000 }]]),
    );
    const [fresh, existing] = view.groups[0]!.rows;
    expect(fresh).toMatchObject({ title: "Sandals", before: "New offer", after: "10 000 ₸" });
    expect(existing).toMatchObject({
      before: "50 000 ₸",
      after: "55 000 ₸",
      delta: "+10.0%",
      flagged: false,
    });
  });
});

describe("describeChangeSet: resolved and invalid", () => {
  it.each([
    ["applied", "Applied"],
    ["rejected", "Rejected"],
  ] as const)("hides the live comparison for %s sets", (status, label) => {
    const view = describeChangeSet(
      changeSet(prices({ offerId: A, price: 99000 }), {
        status,
        requestedBy: "business_agent",
        resolvedAt: T0,
      }),
      offers([[A, { price: 50000 }]]),
    );
    expect(view.statusLabel).toBe(label);
    expect(view.requestedBy).toBe("Business agent");
    expect(view.groups[0]!.rows[0]).toMatchObject({
      before: null,
      delta: null,
      flagged: false,
      after: "99 000 ₸",
    });
    expect(view.flagged).toEqual([]);
  });

  it("reports unreadable change sets", () => {
    const view = describeChangeSet(changeSet({ bad: true }), new Map());
    expect(view).toMatchObject({
      invalid: true,
      groups: [],
      summary: "Unreadable change set",
    });
  });
});
