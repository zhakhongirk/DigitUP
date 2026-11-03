import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { detectKind, ExtractionError, extractText } from "@/server/services/ingestion/extract";

const encode = (text: string) => new TextEncoder().encode(text);

async function buildXlsx(): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const prices = workbook.addWorksheet("Prices");
  prices.addRow(["Item", "Price", "Added"]);
  prices.addRow(["Tea", 4.5, new Date(Date.UTC(2024, 2, 5))]);
  prices.addRow([]);
  prices.addRow(["Coffee", 3, null]);
  const stock = workbook.addWorksheet("Stock");
  stock.addRow(["Item", "Qty"]);
  stock.addRow(["Tea", 10]);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

async function buildDocx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Opening hours</w:t></w:r></w:p><w:p><w:r><w:t>Monday to Friday</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

function buildPdf(text: string): Uint8Array {
  const stream = `BT /F1 18 Tf 50 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encode(out);
}

describe("detectKind", () => {
  it("maps extensions case-insensitively", () => {
    expect(detectKind("a.xlsx")).toBe("xlsx");
    expect(detectKind("Report.PDF")).toBe("pdf");
    expect(detectKind("menu.Csv")).toBe("csv");
    expect(detectKind("notes.docx")).toBe("docx");
    expect(detectKind("readme.md")).toBe("txt");
    expect(detectKind("a.b.txt")).toBe("txt");
  });

  it("returns null for unsupported names", () => {
    expect(detectKind("photo.png")).toBeNull();
    expect(detectKind("noextension")).toBeNull();
    expect(detectKind("old.xls")).toBeNull();
  });
});

describe("extractText", () => {
  it("reads every worksheet of an xlsx file", async () => {
    const { text, tables } = await extractText("xlsx", await buildXlsx());
    expect(tables.map((t) => t.name)).toEqual(["Prices", "Stock"]);
    expect(tables[0]?.rows).toEqual([
      ["Item", "Price", "Added"],
      ["Tea", "4.5", "2024-03-05"],
      ["Coffee", "3"],
    ]);
    expect(text).toBe(
      "Sheet: Prices\nItem | Price | Added\nTea | 4.5 | 2024-03-05\nCoffee | 3\n\nSheet: Stock\nItem | Qty\nTea | 10",
    );
  });

  it("parses semicolon csv with quotes, newlines and a BOM", async () => {
    const csv = '﻿name;note;price\r\n"Tea; green";"line one\nline ""two""";4\r\nCoffee;;3\r\n';
    const { tables } = await extractText("csv", encode(csv));
    expect(tables).toHaveLength(1);
    expect(tables[0]?.rows).toEqual([
      ["name", "note", "price"],
      ["Tea; green", 'line one\nline "two"', "4"],
      ["Coffee", "", "3"],
    ]);
  });

  it("detects comma and tab delimiters", async () => {
    const comma = await extractText("csv", encode('a,b\n"x,y",2'));
    expect(comma.tables[0]?.rows).toEqual([
      ["a", "b"],
      ["x,y", "2"],
    ]);
    const tab = await extractText("csv", encode("a\tb\n1\t2"));
    expect(tab.tables[0]?.rows[1]).toEqual(["1", "2"]);
  });

  it("decodes txt and normalises whitespace", async () => {
    const { text, tables } = await extractText("txt", encode("﻿  Hello\r\n\r\n\r\n\r\nWorld \n"));
    expect(text).toBe("Hello\n\nWorld");
    expect(tables).toEqual([]);
  });

  it("caps very long text", async () => {
    const { text } = await extractText("txt", encode("a".repeat(300_000)));
    expect(text).toHaveLength(200_000);
  });

  it("reads a docx file", async () => {
    const { text } = await extractText("docx", await buildDocx());
    expect(text).toContain("Opening hours");
    expect(text).toContain("Monday to Friday");
  });

  it("reads the demo spreadsheet", async () => {
    const bytes = new Uint8Array(readFileSync("demo-data/shoe-catalog.xlsx"));
    const { tables } = await extractText("xlsx", bytes);
    expect(tables.length).toBeGreaterThan(0);
  });

  it("rejects archives whose real inflated size exceeds the cap despite a small declared size", async () => {
    const zip = new JSZip();
    zip.file("xl/big.xml", "a");
    const bytes = new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
    const payload = deflateRawSync(Buffer.alloc(150 * 1024 * 1024));
    const view = new DataView(bytes.buffer);
    let eocd = bytes.length - 22;
    while (view.getUint32(eocd, true) !== 0x06054b50) eocd--;
    const dir = view.getUint32(eocd + 16, true);
    const local = view.getUint32(dir + 42, true);
    const nameLength = view.getUint16(local + 26, true);
    const head = bytes.subarray(0, local + 30 + nameLength);
    const tail = bytes.subarray(dir);
    const crafted = new Uint8Array(head.length + payload.length + tail.length);
    crafted.set(head, 0);
    crafted.set(payload, head.length);
    crafted.set(tail, head.length + payload.length);
    const cv = new DataView(crafted.buffer);
    const newDir = head.length + payload.length;
    const newEocd = newDir + (eocd - dir);
    cv.setUint16(local + 28, 0, true);
    cv.setUint16(dir - dir + newDir + 10, 8, true);
    cv.setUint32(newDir + 20, payload.length, true);
    cv.setUint32(newDir + 24, 10, true);
    cv.setUint32(newEocd + 16, newDir, true);
    await expect(extractText("xlsx", crafted)).rejects.toThrow("too large");
    await expect(extractText("docx", crafted)).rejects.toThrow("too large");
  });

  it("rejects archives with an unreadable directory", async () => {
    const zip = new JSZip();
    zip.file("a.txt", "hello");
    const bytes = new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
    const view = new DataView(bytes.buffer);
    let eocd = bytes.length - 22;
    while (view.getUint32(eocd, true) !== 0x06054b50) eocd--;
    view.setUint32(view.getUint32(eocd + 16, true), 0, true);
    await expect(extractText("docx", bytes)).rejects.toThrow("Could not read the Word document.");
    await expect(extractText("xlsx", bytes)).rejects.toThrow("Could not read the spreadsheet.");
  });

  it("rejects archives with too many entries", async () => {
    const zip = new JSZip();
    for (let i = 0; i < 2001; i++) zip.file(`f${i}.txt`, "x");
    const bytes = new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
    await expect(extractText("docx", bytes)).rejects.toThrow("too large");
  });

  it("reads a pdf file", async () => {
    const { text } = await extractText("pdf", buildPdf("Delivery within two days"));
    expect(text).toContain("Delivery within two days");
  });

  it("rejects corrupt input", async () => {
    const junk = encode("not a real file");
    await expect(extractText("xlsx", junk)).rejects.toThrow(ExtractionError);
    await expect(extractText("pdf", junk)).rejects.toThrow("Could not read the PDF.");
    await expect(extractText("docx", junk)).rejects.toThrow("Could not read the Word document.");
  });
});
