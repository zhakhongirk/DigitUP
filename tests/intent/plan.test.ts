import { describe, expect, it } from "vitest";
import { barbershopModel } from "@/db/seed-data/barbershop";
import { shoeStoreModel } from "@/db/seed-data/shoe-store";
import { extractPrice, extractSizeSpec } from "@/server/services/intent/budget";
import { builtinLookup } from "@/server/services/intent/lexicon";
import { planIntent } from "@/server/services/intent/plan";
import {
  conversions,
  fromEu,
  resolveSize,
  toEu,
  type SizeGrid,
} from "@/server/services/intent/sizes";
import { editDistance, phonetic, toLatin } from "@/server/services/intent/text";
import { deriveVocabulary } from "@/server/services/intent/vocabulary";
import type { BusinessModelInput } from "@/shared/business-model";

function vocabularyOf(model: BusinessModelInput) {
  return deriveVocabulary({
    offers: (model.offers ?? []).map((o) => ({
      title: o.title,
      description: o.description ?? "",
      category: o.category ?? null,
      attributes: o.attributes ?? {},
    })),
  });
}

const shoes = vocabularyOf(shoeStoreModel);
const barber = vocabularyOf(barbershopModel);

describe("price", () => {
  it.each([
    ["чёрные кроссовки 43 до 75 000", null, 75000],
    ["black sneakers under 75k", null, 75000],
    ["кроссовки 45000-ге дейін", null, 45000],
    ["boots up to 90 000 tg", null, 90000],
    ["sneakers from 30000 up to 60000", 30000, 60000],
    ["кроссовки от 50 до 75 тысяч", 50000, 75000],
    ["кроссовки от 40 000", 40000, null],
  ])("reads the range of %j", (text, min, max) => {
    const price = extractPrice(text);
    expect(price.minPrice).toBe(min);
    expect(price.maxPrice).toBe(max);
  });

  it("does not take a shoe size for a price", () => {
    expect(extractPrice("sneakers size 43")).toMatchObject({ minPrice: null, maxPrice: null });
  });
});

describe("size", () => {
  it.each([
    ["black sneakers size 10 US", "us", [10]],
    ["қара етік 42 өлшем", null, [42]],
    ["boots размер 43", null, [43]],
    ["есть кроссовки 42 размера?", null, [42]],
    ["sneakers EU 42", "eu", [42]],
    ["sneakers UK 9", "uk", [9]],
    ["sneakers 27.5 см", "cm", [27.5]],
    ["sneakers 10 US", "us", [10]],
    ["sneakers size 42-43", null, [42, 43]],
    ["sneakers 42-43", "eu", [42, 43]],
    ["чёрные кроссовки 43", "eu", [43]],
  ])("reads the size of %j", (text, system, values) => {
    const { spec } = extractSizeSpec(text);
    expect(spec?.values).toEqual(values);
    expect(spec?.system).toBe(system);
  });

  it("reads letter sizes", () => {
    expect(extractSizeSpec("hoodie size XL").spec?.letter).toBe("XL");
  });

  it("finds no size in a plain query or a price", () => {
    expect(extractSizeSpec("black sneakers").spec).toBeNull();
    expect(extractSizeSpec("sneakers 75000").spec).toBeNull();
  });
});

describe("size grids", () => {
  it("converts between EU, US, UK and centimetres", () => {
    expect(toEu(10, "us")).toBe(43);
    expect(toEu(27.5, "cm")).toBe(43);
    expect(toEu(9, "uk")).toBe(43);
    expect(fromEu(43, "us")).toBe(10);
    expect(fromEu(43, "cm")).toBe(27.5);
    expect(conversions(43)).toEqual({ eu: "43", us: "10", uk: "9", cm: "27.5" });
  });

  it("uses the women table for US sizes", () => {
    expect(toEu(8, "us", true)).toBe(38.5);
    expect(fromEu(38, "us", true)).toBe(7.5);
  });

  const grid: SizeGrid = { key: "sizes", system: "eu", values: ["40", "41", "42", "43", "44"] };

  it("maps the shopper size onto the sizes the store lists", () => {
    expect(resolveSize({ raw: "10 US", system: "us", values: [10] }, grid, false)).toEqual({
      ok: true,
      values: ["43"],
    });
    expect(resolveSize({ raw: "42-43", system: "eu", values: [42, 43] }, grid, false)).toEqual({
      ok: true,
      values: ["42", "43"],
    });
    expect(resolveSize({ raw: "9", system: null, values: [9] }, grid, false)).toEqual({
      ok: true,
      values: ["42"],
    });
  });

  it("answers in the own system of the store", () => {
    const us: SizeGrid = { key: "sizes", system: "us", values: ["8", "9", "10"] };
    expect(resolveSize({ raw: "43", system: "eu", values: [43] }, us, false)).toEqual({
      ok: true,
      values: ["10"],
    });
  });

  it("reports an unknown grid instead of guessing", () => {
    expect(resolveSize({ raw: "43", system: "eu", values: [43] }, null, false)).toEqual({
      ok: false,
      reason: "grid_unknown",
    });
  });
});

describe("spelling", () => {
  it("transliterates Cyrillic and Kazakh letters", () => {
    expect(toLatin("кроссовки")).toBe("krossovki");
    expect(toLatin("қара")).toBe("qara");
  });

  it("compares words across scripts, typos and double letters", () => {
    expect(phonetic("кросовки")).toBe(phonetic("krossovki"));
    expect(phonetic("қара")).toBe(phonetic("kara"));
    expect(editDistance("snekers", "sneakers", 2)).toBe(1);
    expect(editDistance("sneakres", "sneakers", 2)).toBe(1);
  });

  it.each([
    ["кроссовки", "sneaker"],
    ["кросовки", "sneaker"],
    ["krossovki", "sneaker"],
    ["кроссы", "sneaker"],
    ["ботинки", "boot"],
    ["qara", "black"],
    ["trainers", "sneaker"],
  ])("finds %j in the built-in dictionary", (word, english) => {
    expect(builtinLookup(word)?.words[0]).toBe(english);
  });

  it("does not turn ordinary English words into dictionary hits", () => {
    for (const word of ["boots", "sneakers", "black", "velvet", "belt", "men"]) {
      expect(builtinLookup(word)).toBeNull();
    }
  });
});

describe("planIntent in three languages", () => {
  it("reads color, category, size and budget in Russian", () => {
    const plan = planIntent("чёрные кроссовки 43 до 75 000", shoes);
    expect(plan).toMatchObject({
      lang: "ru",
      category: "Sneakers",
      maxPrice: 75000,
      size: { values: ["43"], key: "size" },
    });
    expect(plan.facets).toEqual([
      { facet: "color", requested: "black", key: "color", values: ["Black", "Black and red"] },
    ]);
    expect(plan.unresolved).toEqual([]);
  });

  it("reads Kazakh", () => {
    const plan = planIntent("қара етік 42 өлшем", shoes);
    expect(plan.lang).toBe("kk");
    expect(plan.category).toBe("Boots");
    expect(plan.size?.values).toEqual(["42"]);
    expect(plan.facets[0]?.requested).toBe("black");
  });

  it("converts a US size and reads a k budget in English", () => {
    const plan = planIntent("black sneakers size 10 US under 75k", shoes);
    expect(plan.lang).toBe("en");
    expect(plan.category).toBe("Sneakers");
    expect(plan.size).toMatchObject({ requested: "size 10 US", values: ["43"] });
    expect(plan.maxPrice).toBe(75000);
  });

  it("uses the women table when the shopper says women", () => {
    const plan = planIntent("women sandals size 8 US", shoes);
    expect(plan.size?.values).toEqual(["39"]);
  });

  it("lets men and women shoppers see unisex offers too", () => {
    const plan = planIntent("men boots", shoes);
    expect(plan.facets[0]?.values).toEqual(["men", "unisex"]);
  });

  it.each([
    ["кросовки", "doubled letter"],
    ["krossovki", "transliteration"],
    ["snekers", "typo"],
    ["Sneekers", "typo"],
  ])("finds the sneakers category from %j (%s)", (text) => {
    expect(planIntent(text, shoes).category).toBe("Sneakers");
  });

  it("recognizes a typo in a color word", () => {
    expect(planIntent("чорные кросовки", shoes).facets[0]?.requested).toBe("black");
  });

  it("records how each word was understood", () => {
    const plan = planIntent("blak snekers", shoes);
    expect(plan.interpreted.map((i) => [i.from, i.to])).toEqual([
      ["blak", "black"],
      ["snekers", "Sneakers"],
    ]);
  });

  it("matches brand names typed in Cyrillic", () => {
    expect(planIntent("Нордикс", shoes).terms).toEqual(["nordix"]);
  });

  it("lists words it could not place instead of silently dropping them", () => {
    const plan = planIntent("unicorn sneakers", shoes);
    expect(plan.category).toBe("Sneakers");
    expect(plan.unresolved).toEqual(['unknown word "unicorn"']);
  });

  it("keeps an unknown query as free text so the search finds nothing", () => {
    expect(planIntent("unicorn", shoes).terms).toEqual(["unicorn"]);
  });

  it("says the size grid is unknown for a store without sizes", () => {
    const plan = planIntent("haircut size 43", barber);
    expect(plan.category).toBe("Haircuts");
    expect(plan.size).toBeNull();
    expect(plan.unresolved).toContain("size grid unknown");
  });

  it("understands services too", () => {
    expect(planIntent("стрижка", barber).category).toBe("Haircuts");
    expect(planIntent("сақал", barber).category).toBe("Beard");
  });
});

describe("store vocabulary", () => {
  it("is derived from the catalog data of the shoe store", () => {
    expect(shoes.categories).toMatchObject({
      sneakers: "Sneakers",
      boots: "Boots",
      sandals: "Sandals",
    });
    expect(shoes.sizes).toEqual({
      key: "size",
      system: "eu",
      values: Array.from({ length: 12 }, (_, i) => String(35 + i)),
    });
    expect(shoes.facets.color?.values.black).toEqual(["Black", "Black and red"]);
    expect(shoes.facets.season?.key).toBe("season");
    expect(shoes.synonyms["кроссов"]).toBe("sneaker");
  });

  it("has no sizes or color for the barbershop but knows its categories", () => {
    expect(barber.sizes).toBeNull();
    expect(barber.facets.color).toBeUndefined();
    expect(barber.categories).toMatchObject({ haircuts: "Haircuts", beard: "Beard" });
    expect(barber.synonyms["стриж"]).toBe("haircut");
  });
});
