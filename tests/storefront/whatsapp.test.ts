import { describe, expect, it } from "vitest";
import { whatsappDigits, whatsappLink } from "@/server/storefront/whatsapp";

describe("whatsappDigits", () => {
  it.each([
    ["+7 (700) 111-22-33", "77001112233"],
    ["8 700 111 22 33", "77001112233"],
    ["https://wa.me/77001112233?text=hi", "77001112233"],
    ["  +44 20 7946 0958 ", "442079460958"],
  ])("keeps only the digits of %j", (raw, digits) => {
    expect(whatsappDigits(raw)).toBe(digits);
  });

  it.each([[undefined], [null], [""], ["call us"], ["12345"], ["1".repeat(16)], [42]])(
    "rejects %j",
    (raw) => {
      expect(whatsappDigits(raw)).toBeNull();
    },
  );
});

describe("whatsappLink", () => {
  it("builds a wa.me link with a digits-only number and an encoded message", () => {
    const message = "Hello! I am writing from the Shoe Shop store.";
    const link = whatsappLink("+7 700 111 22 33", message);
    expect(link).toBe(`https://wa.me/77001112233?text=${encodeURIComponent(message)}`);
    expect(new URL(link!).searchParams.get("text")).toBe(message);
  });

  it("encodes Cyrillic and special characters", () => {
    const link = whatsappLink("77001112233", "Магазин & Co #1")!;
    expect(new URL(link).searchParams.get("text")).toBe("Магазин & Co #1");
    expect(link).not.toContain(" ");
  });

  it("returns null without a usable number", () => {
    expect(whatsappLink(undefined, "Hi")).toBeNull();
    expect(whatsappLink("n/a", "Hi")).toBeNull();
  });
});
