import { describe, expect, it } from "vitest";
import { DICTIONARIES, negotiateLang, t } from "@/server/storefront/i18n";

describe("negotiateLang", () => {
  it("defaults to English", () => {
    expect(negotiateLang(null)).toBe("en");
    expect(negotiateLang("")).toBe("en");
    expect(negotiateLang("en-US,en;q=0.9")).toBe("en");
    expect(negotiateLang("de-DE,fr;q=0.8")).toBe("en");
  });

  it("picks Russian when it is preferred", () => {
    expect(negotiateLang("ru")).toBe("ru");
    expect(negotiateLang("ru-RU,ru;q=0.9,en;q=0.8")).toBe("ru");
    expect(negotiateLang("en;q=0.5,ru;q=0.9")).toBe("ru");
  });

  it("treats Kazakh as Russian", () => {
    expect(negotiateLang("kk-KZ,kk;q=0.9")).toBe("ru");
  });

  it("keeps English when it ranks above Russian", () => {
    expect(negotiateLang("en-US,ru;q=0.5")).toBe("en");
    expect(negotiateLang("ru;q=0,en")).toBe("en");
  });
});

describe("dictionaries", () => {
  it("define the same keys in both languages", () => {
    expect(Object.keys(DICTIONARIES.ru).sort()).toEqual(Object.keys(DICTIONARIES.en).sort());
  });

  it("have no empty strings and matching placeholders", () => {
    const vars = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const key of Object.keys(DICTIONARIES.en) as (keyof typeof DICTIONARIES.en)[]) {
      expect(DICTIONARIES.en[key]).not.toBe("");
      expect(DICTIONARIES.ru[key]).not.toBe("");
      expect(vars(DICTIONARIES.ru[key])).toEqual(vars(DICTIONARIES.en[key]));
    }
  });

  it("interpolates variables", () => {
    expect(t("en", "pageOf", { page: 2, total: 5 })).toBe("Page 2 of 5");
    expect(t("ru", "pageOf", { page: 2, total: 5 })).toBe("Страница 2 из 5");
  });
});
