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

  it("picks Kazakh for kk and kk-KZ", () => {
    expect(negotiateLang("kk")).toBe("kk");
    expect(negotiateLang("kk-KZ,kk;q=0.9")).toBe("kk");
    expect(negotiateLang("ru;q=0.8,kk-KZ;q=0.9")).toBe("kk");
    expect(negotiateLang("en-US,kk;q=0.5")).toBe("en");
  });

  it("keeps English when it ranks above Russian", () => {
    expect(negotiateLang("en-US,ru;q=0.5")).toBe("en");
    expect(negotiateLang("ru;q=0,en")).toBe("en");
  });
});

describe("dictionaries", () => {
  it("define the same keys in every language", () => {
    expect(Object.keys(DICTIONARIES.ru).sort()).toEqual(Object.keys(DICTIONARIES.en).sort());
    expect(Object.keys(DICTIONARIES.kk).sort()).toEqual(Object.keys(DICTIONARIES.en).sort());
  });

  it("have no empty strings and matching placeholders", () => {
    const vars = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const key of Object.keys(DICTIONARIES.en) as (keyof typeof DICTIONARIES.en)[]) {
      expect(DICTIONARIES.en[key]).not.toBe("");
      expect(DICTIONARIES.ru[key]).not.toBe("");
      expect(vars(DICTIONARIES.ru[key])).toEqual(vars(DICTIONARIES.en[key]));
      expect(DICTIONARIES.kk[key]).not.toBe("");
      expect(vars(DICTIONARIES.kk[key])).toEqual(vars(DICTIONARIES.en[key]));
      expect(DICTIONARIES.kk[key]).not.toContain(String.fromCharCode(0x2014));
    }
  });

  it("interpolates variables", () => {
    expect(t("en", "pageOf", { page: 2, total: 5 })).toBe("Page 2 of 5");
    expect(t("ru", "pageOf", { page: 2, total: 5 })).toBe("Страница 2 из 5");
    expect(t("kk", "pageOf", { page: 2, total: 5 })).toBe("5 беттің 2-беті");
  });
});
