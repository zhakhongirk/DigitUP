import { describe, expect, it } from "vitest";
import {
  buildOfferInput,
  catalogHref,
  commonOfferType,
  matchesFilters,
  newOfferInput,
  pageCount,
  parseCatalogParams,
  parsePrice,
  statusesFor,
  toFormValues,
  toRow,
} from "@/server/owner/catalog";
import type { OfferView } from "@/server/services/catalog";

const ID = "00000000-0000-4000-8000-000000000001";

function offer(overrides: Partial<OfferView> = {}): OfferView {
  return {
    id: ID,
    tenantId: "t",
    offerTypeId: "ot",
    offerTypeKey: "product",
    offerTypeName: "Product",
    title: "Boots",
    description: "Leather",
    category: "Shoes",
    attributes: { size: "42" },
    price: 50000,
    currency: "KZT",
    priceStatus: "confirmed",
    availability: "in_stock",
    status: "active",
    imageUrl: "/boots.jpg",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const VALID = {
  title: "Boots",
  description: "Leather",
  category: "Shoes",
  price: "50000",
  currency: "kzt",
  availability: "in_stock",
  status: "active",
};

describe("parseCatalogParams", () => {
  it("applies defaults", () => {
    expect(parseCatalogParams({})).toEqual({
      q: "",
      category: "",
      status: "active",
      availability: "",
      priceOnRequest: false,
      page: 1,
      offerId: null,
    });
  });

  it("reads values and rejects bad ones", () => {
    const parsed = parseCatalogParams({
      q: " boots ",
      category: "Shoes",
      status: "all",
      page: "3",
      offer: ID,
    });
    expect(parsed).toEqual({
      q: "boots",
      category: "Shoes",
      status: "all",
      availability: "",
      priceOnRequest: false,
      page: 3,
      offerId: ID,
    });
    expect(parseCatalogParams({ status: "x", page: "-2" })).toMatchObject({
      status: "active",
      page: 1,
    });
    expect(parseCatalogParams({ page: ["2", "5"] }).page).toBe(2);
  });
});

describe("helpers", () => {
  it("maps status filters", () => {
    expect(statusesFor("draft")).toEqual(["draft"]);
    expect(statusesFor("all")).toEqual(["active", "draft", "archived"]);
  });

  it("builds hrefs without defaults", () => {
    expect(catalogHref({})).toBe("/app/catalog");
    expect(catalogHref({ q: "a b", status: "active", page: 1 })).toBe("/app/catalog?q=a+b");
    expect(catalogHref({ status: "draft", page: 2, offerId: ID })).toBe(
      `/app/catalog?status=draft&page=2&offer=${ID}`,
    );
  });

  it("reads and keeps the availability and price filters", () => {
    const parsed = parseCatalogParams({ availability: "unknown", price: "on_request" });
    expect(parsed).toMatchObject({ availability: "unknown", priceOnRequest: true });
    expect(parseCatalogParams({ availability: "x", price: "y" })).toMatchObject({
      availability: "",
      priceOnRequest: false,
    });
    expect(catalogHref(parsed)).toBe("/app/catalog?availability=unknown&price=on_request");
  });

  it("matches offers against the filters", () => {
    const none = { availability: "" as const, priceOnRequest: false };
    expect(matchesFilters(offer(), none)).toBe(true);
    expect(matchesFilters(offer(), { ...none, availability: "unknown" })).toBe(false);
    expect(
      matchesFilters(offer({ availability: "unknown" }), { ...none, availability: "unknown" }),
    ).toBe(true);
    expect(matchesFilters(offer(), { ...none, priceOnRequest: true })).toBe(false);
    expect(matchesFilters(offer({ price: null }), { ...none, priceOnRequest: true })).toBe(true);
    expect(
      matchesFilters(offer({ priceStatus: "on_request" }), { ...none, priceOnRequest: true }),
    ).toBe(true);
  });

  it("picks the most common offer type", () => {
    const types = [{ key: "service" }, { key: "product" }];
    expect(commonOfferType(types, [])).toBe("service");
    expect(
      commonOfferType(types, [
        { offerTypeKey: "product" },
        { offerTypeKey: "product" },
        { offerTypeKey: "service" },
      ]),
    ).toBe("product");
    expect(commonOfferType([], [])).toBeNull();
  });

  it("builds a draft offer with no price", () => {
    expect(newOfferInput("product")).toMatchObject({
      offer_type: "product",
      price: null,
      price_status: "on_request",
      availability: "unknown",
      status: "draft",
    });
  });

  it("counts pages", () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(20)).toBe(1);
    expect(pageCount(21)).toBe(2);
  });

  it("parses prices", () => {
    expect(parsePrice("1 250,50")).toBe(1250.5);
    expect(parsePrice("0")).toBe(0);
    expect(parsePrice("abc")).toBeNull();
    expect(parsePrice("-5")).toBeNull();
    expect(parsePrice("1.234")).toBeNull();
  });
});

describe("toRow", () => {
  it("formats a priced offer", () => {
    expect(toRow(offer())).toMatchObject({
      title: "Boots",
      category: "Shoes",
      price: "50 000 ₸",
      availabilityLabel: "In stock",
      statusLabel: "Active",
    });
  });

  it("shows on request and empty category", () => {
    const row = toRow(offer({ price: null, category: null, availability: "unknown" }));
    expect(row.price).toBe("On request");
    expect(row.category).toBe("");
    expect(row.availabilityLabel).toBe("Unknown");
  });
});

describe("toFormValues", () => {
  it("fills the form from the offer", () => {
    expect(toFormValues(offer())).toMatchObject({ price: "50000", priceOnRequest: false });
    expect(toFormValues(offer({ price: null, currency: null }))).toMatchObject({
      price: "",
      currency: "",
      priceOnRequest: true,
    });
  });
});

describe("buildOfferInput", () => {
  it("keeps untouched fields and applies edits", () => {
    const result = buildOfferInput(offer(), form({ ...VALID, title: "  New boots " }));
    expect(result).toEqual({
      input: {
        id: ID,
        title: "New boots",
        description: "Leather",
        category: "Shoes",
        offer_type: "product",
        attributes: { size: "42" },
        price: 50000,
        currency: "KZT",
        price_status: "confirmed",
        availability: "in_stock",
        status: "active",
        image_url: "/boots.jpg",
      },
    });
  });

  it("switches to price on request", () => {
    const result = buildOfferInput(offer(), form({ ...VALID, priceOnRequest: "on", price: "" }));
    expect(result).toMatchObject({ input: { price: null, price_status: "on_request" } });
  });

  it("clears an empty category", () => {
    const result = buildOfferInput(offer(), form({ ...VALID, category: " " }));
    expect(result).toMatchObject({ input: { category: null } });
  });

  it.each([
    [{ title: " " }, "Enter a title."],
    [{ price: "" }, "Enter a price or tick price on request."],
    [{ price: "ten" }, "Price must be a number such as 1250 or 1250.50."],
    [{ currency: "" }, "Enter a currency such as KZT."],
    [{ availability: "later" }, "Choose an availability."],
    [{ status: "gone" }, "Choose a status."],
  ])("rejects %j", (patch, error) => {
    expect(buildOfferInput(offer(), form({ ...VALID, ...patch }))).toEqual({ error });
  });
});
