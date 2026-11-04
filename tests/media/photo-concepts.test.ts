import { describe, expect, it } from "vitest";
import { englishNoun, photoConcepts } from "@/server/owner/photo-concepts";

const offer = (title: string, category: string | null = null, offerTypeKey = "product") => ({
  offerTypeKey,
  category,
  title,
});

describe("englishNoun", () => {
  it.each([
    ["Кроссовки", "shoe"],
    ["КЕДЫ мужские", "shoe"],
    ["Ботинки зимние", "shoe"],
    ["аяқ киім", "shoe"],
    ["Sneakers", "shoe"],
    ["Сумка", "bag"],
    ["Рюкзак городской", "bag"],
    ["Футболка", "shirt"],
    ["Худи", "shirt"],
    ["Куртка", "jacket"],
    ["Платье летнее", "dress"],
    ["Одежда", "clothing"],
    ["Кепка", "hat"],
    ["Шапка", "hat"],
    ["Часы", "watch"],
    ["Очки", "glasses"],
    ["Бутылка", "bottle"],
    ["Телефон", "phone"],
  ])("maps %s to %s", (text, noun) => {
    expect(englishNoun(text)).toBe(noun);
  });

  it("returns null for unknown words", () => {
    expect(englishNoun("Nike Air Max 90")).toBeNull();
    expect(englishNoun("")).toBeNull();
  });
});

describe("photoConcepts", () => {
  it("puts the mapped noun first for a Russian category", () => {
    expect(photoConcepts(offer("Nike Air Max 90", "Кроссовки"))[0]).toBe("shoe");
  });

  it("uses the offer type, then category and title", () => {
    expect(photoConcepts(offer("Altai", "Boots", "shoe"))).toEqual([
      "shoe",
      "Boots",
      "Altai",
      "bag",
    ]);
  });

  it("skips generic types and non-English raw words", () => {
    expect(photoConcepts(offer("Сумка кожаная"))).toEqual(["bag", "shoe", "bottle", "box"]);
  });

  it("ends with the generic fallbacks and caps the list at four", () => {
    const list = photoConcepts(offer("Что-то", "Разное"));
    expect(list).toEqual(["shoe", "bag", "bottle", "box"]);
    expect(photoConcepts(offer("Red Mug", "Cups", "drink")).length).toBeLessThanOrEqual(4);
  });

  it("has no duplicates", () => {
    const list = photoConcepts(offer("Shoe", "Shoe", "shoe"));
    expect(new Set(list).size).toBe(list.length);
  });
});
