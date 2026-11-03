import { describe, expect, it, vi } from "vitest";
import type { Order } from "@/server/services/orders";
import {
  CSV_BOM,
  csvCell,
  exportFilename,
  orderRow,
  ordersCsv,
  parseExportRange,
  toCsv,
} from "@/server/owner/csv";

describe("csvCell", () => {
  it("leaves plain text alone and blanks nullish values", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(12.5)).toBe("12.5");
  });

  it("quotes commas, quotes and line breaks", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("a\nb")).toBe('"a\nb"');
  });

  it("neutralizes formula prefixes", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("=1")).toBe("'=1");
    expect(csvCell("+SUM(1)")).toBe("'+SUM(1)");
    expect(csvCell("-cmd|x")).toBe("'-cmd|x");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell("\rx")).toBe(`"'\rx"`);
  });
});

describe("csvCell numbers and phones", () => {
  it("leaves signed numbers and phone numbers alone", () => {
    expect(csvCell("+7 701 555 12 34")).toBe("+7 701 555 12 34");
    expect(csvCell("+7 (701) 555-12-34")).toBe("+7 (701) 555-12-34");
    expect(csvCell("-1")).toBe("-1");
    expect(csvCell(-12.5)).toBe("-12.5");
  });
});

describe("toCsv", () => {
  it("uses CRLF and a BOM", () => {
    const csv = toCsv([
      ["a", "b"],
      ["Привет", 1],
    ]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv.slice(1)).toBe("a,b\r\nПривет,1\r\n");
  });
});

describe("export helpers", () => {
  it("parses the range with a fallback", () => {
    expect(parseExportRange("7")).toBe("7");
    expect(parseExportRange("30")).toBe("30");
    expect(parseExportRange("x")).toBe("all");
    expect(parseExportRange(null)).toBe("all");
  });

  it("builds a dated filename", () => {
    expect(exportFilename("shop", "orders", new Date("2026-11-02T10:00:00Z"))).toBe(
      "shop-orders-2026-11-02.csv",
    );
  });

  it("dates the filename in the app time zone", () => {
    vi.stubEnv("APP_TIMEZONE", "Asia/Almaty");
    expect(exportFilename("shop", "orders", new Date("2026-11-02T20:30:00Z"))).toBe(
      "shop-orders-2026-11-03.csv",
    );
    vi.unstubAllEnvs();
  });
});

describe("orders csv", () => {
  const base = {
    id: "abcdef12-3456-4789-8abc-def012345678",
    items: [
      { offerId: "o", title: "Runner", quantity: 2, unitPrice: 5, currency: "KZT", lineTotal: 10 },
    ],
    contact: { name: "Ann", phone: "+7 701 000 11 22" },
    fulfillment: null,
    deliveryAddress: null,
    city: null,
    status: "submitted",
    source: "storefront",
    total: 10,
    currency: "KZT",
    createdAt: new Date("2026-11-02T09:00:00Z"),
    submittedAt: new Date("2026-11-02T09:05:00Z"),
  } as unknown as Order;

  it("ends the header with Fulfillment and Address", () => {
    const header = ordersCsv([]).replace(CSV_BOM, "").trim().split(",");
    expect(header.slice(-2)).toEqual(["Fulfillment", "Address"]);
    expect(header).toHaveLength(14);
  });

  it("writes the raw fulfillment and the address with the city", () => {
    const delivery = orderRow({
      ...base,
      fulfillment: "delivery",
      deliveryAddress: "Abay 10",
      city: "Almaty",
    });
    expect(delivery).toHaveLength(14);
    expect(delivery.slice(-2)).toEqual(["delivery", "Abay 10, Almaty"]);
    expect(orderRow({ ...base, fulfillment: "pickup" }).slice(-2)).toEqual(["pickup", ""]);
    expect(orderRow(base).slice(-2)).toEqual(["", ""]);
    expect(orderRow({ ...base, deliveryAddress: "Abay 10" }).at(-1)).toBe("Abay 10");
  });
});
