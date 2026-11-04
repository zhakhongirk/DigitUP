import { describe, expect, it } from "vitest";
import {
  importBusinessModel,
  parsePrice,
  parseSizes,
  unifyBrands,
} from "@/server/services/onboarding/import";
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
    expect(keys).toEqual(["brand", "size"]);
    expect(model.offers).toHaveLength(3);
    expect(model.offers?.[0]).toMatchObject({
      title: "Runner",
      category: "Sneakers",
      price: 42000,
      currency: "KZT",
      price_status: "confirmed",
      availability: "in_stock",
      attributes: { brand: "Nike", size: "40" },
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

describe("size expansion", () => {
  const header = ["Name", "Category", "Sizes", "Price", "Stock"];

  it("turns a size range into one offer per size with the row stock", () => {
    const model = build({
      businessName: "Stride",
      texts: [],
      tables: table([header, ["Altai Boots", "Boots", "40-43", "89 000 ₸", "5"]]),
    });
    expect(model.offers?.map((o) => o.title)).toEqual([
      "Altai Boots 40",
      "Altai Boots 41",
      "Altai Boots 42",
      "Altai Boots 43",
    ]);
    expect(model.offers?.every((o) => o.model === "Altai Boots")).toBe(true);
    expect(model.offers?.[1]).toMatchObject({
      attributes: { size: "41" },
      availability: "in_stock",
      price: 89000,
    });
  });

  it("leaves stock unknown when the row has none", () => {
    const model = build({
      businessName: "Stride",
      texts: [],
      tables: table([header.slice(0, 4), ["Altai Boots", "Boots", "40, 41", "89 000 ₸"]]),
    });
    expect(model.offers?.map((o) => o.availability)).toEqual(["unknown", "unknown"]);
  });

  it("reads stock written per size", () => {
    const model = build({
      businessName: "Stride",
      texts: [],
      tables: table([header, ["Altai Boots", "Boots", "40:3, 41:0", "89 000 ₸", ""]]),
    });
    expect(model.offers?.map((o) => o.availability)).toEqual(["in_stock", "out_of_stock"]);
  });

  it("groups rows that repeat a name with one size each", () => {
    const model = build({
      businessName: "Stride",
      texts: [],
      tables: table([
        header,
        ["Altai Boots", "Boots", "40", "89 000 ₸", "2"],
        ["Altai Boots", "Boots", "41", "89 000 ₸", "0"],
      ]),
    });
    expect(model.offers?.map((o) => [o.title, o.model, o.availability])).toEqual([
      ["Altai Boots 40", "Altai Boots", "in_stock"],
      ["Altai Boots 41", "Altai Boots", "out_of_stock"],
    ]);
  });

  it("parses letter ranges and rejects other text", () => {
    expect(parseSizes("S-L").map((s) => s.size)).toEqual(["S", "M", "L"]);
    expect(parseSizes("one size")).toEqual([]);
  });
});

describe("messy price list", () => {
  const header = ["Наименование", "Бренд", "Размеры", "Цена", "Наличие"];
  const messy = table([
    ["Прайс на ноябрь"],
    [],
    header,
    ["Кроссовки Air Zoom", "Nike", "40-42", "45 000 ₸", "есть"],
    ["Кроссовки Pegasus", "Найк", "41,42", "52000", "есть"],
    ["", "", "", "", ""],
    ["Кеды Chuck 70", "Converse", "EU 42", "22 000", "нет"],
    ["Лоферы Classic", "Mokko", "42 р.", "", "есть"],
    header,
    ["Итого", "", "", "119000", ""],
    [],
  ]);

  it("reads size formats with prefixes and suffixes", () => {
    expect(parseSizes("EU 42").map((s) => s.size)).toEqual(["42"]);
    expect(parseSizes("42 р.").map((s) => s.size)).toEqual(["42"]);
    expect(parseSizes("размер 43").map((s) => s.size)).toEqual(["43"]);
    expect(parseSizes("41,42,43").map((s) => s.size)).toEqual(["41", "42", "43"]);
  });

  it("skips repeated headers, totals and blank rows", () => {
    const model = build({ businessName: "Shop", texts: [], tables: messy });
    const titles = model.offers!.map((o) => o.title);
    expect(titles).not.toContain("Наименование");
    expect(titles).not.toContain("Итого");
    expect(titles).toEqual([
      "Кроссовки Air Zoom 40",
      "Кроссовки Air Zoom 41",
      "Кроссовки Air Zoom 42",
      "Кроссовки Pegasus 41",
      "Кроссовки Pegasus 42",
      "Кеды Chuck 70",
      "Лоферы Classic",
    ]);
  });

  it("keeps one size per single-size row and one spelling per brand", () => {
    const model = build({ businessName: "Shop", texts: [], tables: messy });
    const byTitle = new Map(model.offers!.map((o) => [o.title, o]));
    expect(byTitle.get("Кеды Chuck 70")?.attributes).toMatchObject({ size: "42" });
    expect(byTitle.get("Лоферы Classic")?.attributes).toMatchObject({ size: "42" });
    expect(new Set(model.offers!.slice(0, 5).map((o) => o.attributes?.brand))).toEqual(
      new Set(["Nike"]),
    );
  });

  it("makes unpriced rows price on request and lists the gaps", () => {
    const model = build({ businessName: "Shop", texts: ["Доставка по городу."], tables: messy });
    const loafers = model.offers!.find((o) => o.title === "Лоферы Classic");
    expect(loafers).toMatchObject({ price: null, price_status: "on_request" });
    expect(fields(model)).toContain("offers.price");
    expect(fields(model)).toContain("policies.returns");
  });
});

describe("unifyBrands", () => {
  it("rewrites alias spellings to the Latin brand and leaves other attributes alone", () => {
    const offers = [
      { title: "A", attributes: { brand: "Nike", size: "42" } },
      { title: "B", attributes: { brand: "Найк" } },
      { title: "C", attributes: { brand: "mokko" } },
      { title: "D", attributes: { brand: "Mokko" } },
      { title: "E" },
    ];
    const out = unifyBrands(offers);
    expect(out.map((o) => o.attributes?.brand)).toEqual([
      "Nike",
      "Nike",
      "Mokko",
      "Mokko",
      undefined,
    ]);
    expect(out[0]?.attributes).toEqual({ brand: "Nike", size: "42" });
  });
});
