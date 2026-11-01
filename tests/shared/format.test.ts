import { describe, expect, it } from "vitest";
import { formatPrice } from "@/shared/format";

describe("formatPrice", () => {
  it("formats tenge with grouped thousands", () => {
    expect(formatPrice(42000, "KZT")).toBe("42 000 ₸");
    expect(formatPrice(5000, "KZT")).toBe("5 000 ₸");
    expect(formatPrice(999, "KZT")).toBe("999 ₸");
    expect(formatPrice(1234567, "KZT")).toBe("1 234 567 ₸");
  });

  it("uses symbols for USD, EUR and RUB", () => {
    expect(formatPrice(1250, "USD")).toBe("$1 250");
    expect(formatPrice(19.5, "EUR")).toBe("€19.50");
    expect(formatPrice(3000, "RUB")).toBe("3 000 ₽");
  });

  it("falls back to the currency code", () => {
    expect(formatPrice(1234, "ABC")).toBe("1 234 ABC");
    expect(formatPrice(1234, "abc")).toBe("1 234 ABC");
    expect(formatPrice(1234, null)).toBe("1 234");
  });

  it("handles zero, negatives and non-finite amounts", () => {
    expect(formatPrice(0, "KZT")).toBe("0 ₸");
    expect(formatPrice(-1500, "USD")).toBe("-$1 500");
    expect(formatPrice(Number.NaN, "KZT")).toBe("NaN KZT");
  });
});
