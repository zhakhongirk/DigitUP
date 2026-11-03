import { describe, expect, it, vi } from "vitest";
import { CSV_BOM, csvCell, exportFilename, parseExportRange, toCsv } from "@/server/owner/csv";

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
