import { describe, expect, it } from "vitest";
import { importBusinessModel, parsePrice } from "@/server/services/onboarding/import";
import { businessModelSchema } from "@/shared/business-model";

function build(input: Parameters<typeof importBusinessModel>[0]) {
  const model = importBusinessModel(input);
  const parsed = businessModelSchema.safeParse(model);
  expect(parsed.error?.issues).toBeUndefined();
  return model;
}

const table = (rows: string[][]) => [{ name: "Sheet", rows }];
const fields = (model: ReturnType<typeof build>) => model.missing_info?.map((m) => m.field);

describe("parsePrice", () => {
  it.each([
    ["42 000 ₸", 42000],
    ["1,250.50", 1250.5],
    ["1 250,5", 1250.5],
    ["1.250,50", 1250.5],
    ["12,000", 12000],
    ["4500", 4500],
  ])("parses %s", (raw, value) => {
    expect(parsePrice(raw)).toBe(value);
  });

  it.each(["on request", "", "-", "договорная"])("returns null for %j", (raw) => {
    expect(parsePrice(raw)).toBeNull();
  });
});

describe("importBusinessModel", () => {
  const shoes = table([
    ["Name", "Category", "Brand", "Sizes", "Price", "Stock"],
    ["Runner", "Sneakers", "Nike", "40", "42 000 ₸", "5"],
    ["Trail", "Sneakers", "Adidas", "41", "38 000 ₸", "0"],
    ["Boot", "Boots", "Nike", "42", "", "3"],
  ]);

  it("turns a shoe table into one product type with offers", () => {
    const model = build({ businessName: "Stride", texts: [], tables: shoes });
    expect(model.offer_types).toHaveLength(1);
    expect(model.offer_types?.[0]).toMatchObject({ key: "product", kind: "product" });
    const keys = model.offer_types?.[0]?.attributes?.map((a) => a.key);
    expect(keys).toEqual(["brand", "sizes"]);
    expect(model.offers).toHaveLength(3);
    expect(model.offers?.[0]).toMatchObject({
      title: "Runner",
      category: "Sneakers",
      price: 42000,
      currency: "KZT",
      price_status: "confirmed",
      availability: "in_stock",
      attributes: { brand: "Nike", sizes: 40 },
    });
  });

  it("marks zero stock as out of stock and blank prices as on request", () => {
    const model = build({ businessName: "Stride", texts: [], tables: shoes });
    expect(model.offers?.[1]?.availability).toBe("out_of_stock");
    expect(model.offers?.[2]).toMatchObject({
      price: null,
      price_status: "on_request",
      currency: null,
    });
    expect(fields(model)).toContain("offers.price");
  });

  it("detects the currency from the text when cells have none", () => {
    const model = build({
      businessName: "Shop",
      texts: ["All prices in USD."],
      tables: table([
        ["Product", "Price"],
        ["Tea", "5"],
      ]),
    });
    expect(model.offers?.[0]).toMatchObject({ price: 5, currency: "USD" });
  });

  it("asks for the currency when it cannot be found", () => {
    const model = build({
      businessName: "Shop",
      texts: [],
      tables: table([
        ["Product", "Price"],
        ["Tea", "5"],
      ]),
    });
    expect(model.offers?.[0]).toMatchObject({ price: null, price_status: "on_request" });
    expect(fields(model)).toContain("offers.currency");
  });

  it("uses a currency column", () => {
    const model = build({
      businessName: "Shop",
      texts: [],
      tables: table([
        ["Name", "Price", "Currency"],
        ["Tea", "5", "EUR"],
      ]),
    });
    expect(model.offers?.[0]).toMatchObject({ price: 5, currency: "EUR" });
  });

  it("treats a table with a Duration column as services", () => {
    const model = build({
      businessName: "Salon",
      texts: [],
      tables: table([
        ["Service", "Duration", "Price"],
        ["Haircut", "45", "5 000 ₸"],
      ]),
    });
    expect(model.offer_types?.[0]).toMatchObject({ key: "service", kind: "service" });
    expect(model.offers?.[0]).toMatchObject({
      offer_type: "service",
      attributes: { duration: 45 },
    });
  });

  it("finds a header row that is not the first row", () => {
    const model = build({
      businessName: "Shop",
      texts: [],
      tables: table([["Price list 2024"], [], ["Name", "Price"], ["Tea", "5 $"]]),
    });
    expect(model.offers).toHaveLength(1);
    expect(model.offers?.[0]).toMatchObject({ title: "Tea", price: 5, currency: "USD" });
  });

  it("picks the largest table", () => {
    const model = build({
      businessName: "Shop",
      texts: [],
      tables: [
        { name: "Small", rows: [["Name"], ["A"]] },
        { name: "Big", rows: [["Name"], ["B"], ["C"], ["D"]] },
      ],
    });
    expect(model.offers?.map((o) => o.title)).toEqual(["B", "C", "D"]);
  });

  it("reports missing offers when there is no table", () => {
    const model = build({ businessName: "Shop", texts: ["We sell tea."], tables: [] });
    expect(model.offers).toEqual([]);
    expect(fields(model)).toContain("offers");
  });

  it("detects contacts and policies from text", () => {
    const model = build({
      businessName: "Shop",
      texts: [
        "Tea shop in Almaty.\nWrite to Hello@Shop.kz or call +7 701 123 45 67. Instagram: tea.shop\nWe offer free delivery within the city.\nPayment by card or cash.\nReturns accepted within 14 days.\nOpen daily 10:00-20:00.",
      ],
      tables: [],
    });
    expect(model.profile.contacts).toMatchObject({
      email: "hello@shop.kz",
      phone: "+7 701 123 45 67",
      instagram: "@tea.shop",
    });
    expect(model.profile.description).toMatch(/^Tea shop in Almaty\./);
    expect(model.policies?.delivery).toMatch(/free delivery/);
    expect(model.policies?.payment).toMatch(/card or cash/);
    expect(model.policies?.returns).toMatch(/14 days/);
    expect(model.policies?.working_hours).toMatch(/10:00/);
    expect(fields(model)).not.toContain("profile.contacts");
    expect(fields(model)).not.toContain("policies.delivery");
  });

  it("flags missing contacts as blocking", () => {
    const model = build({ businessName: "Shop", texts: ["We sell tea."], tables: [] });
    const contacts = model.missing_info?.find((m) => m.field === "profile.contacts");
    expect(contacts?.severity).toBe("blocking");
  });

  it("produces valid keys for non-latin headers", () => {
    const model = build({
      businessName: "Обувь",
      texts: [],
      tables: table([
        ["Наименование", "Цена", "Бренд", "Размер"],
        ["Кроссовки", "15 000 тенге", "Nike", "40"],
        ["Ботинки", "20 000 тенге", "Adidas", "41"],
      ]),
    });
    expect(model.offers).toHaveLength(2);
    expect(model.offers?.[0]).toMatchObject({ price: 15000, currency: "KZT" });
    const keys = model.offer_types?.[0]?.attributes?.map((a) => a.key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("keeps https image links only", () => {
    const model = build({
      businessName: "Shop",
      texts: [],
      tables: table([
        ["Name", "Image"],
        ["A", "https://example.com/a.jpg"],
        ["B", "javascript:alert(1)"],
      ]),
    });
    expect(model.offers?.map((o) => o.image_url)).toEqual(["https://example.com/a.jpg", null]);
  });
});
