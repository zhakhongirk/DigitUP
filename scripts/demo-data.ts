/**
 * Writes sample onboarding files to demo-data/: a shoe catalog spreadsheet,
 * the store terms as a PDF and a barbershop price list as CSV.
 *
 *   pnpm demo:data
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { barbershopModel } from "@/db/seed-data/barbershop";
import { shoeStoreModel } from "@/db/seed-data/shoe-store";

const OUT = path.resolve("demo-data");

function sizeRange(sizes: unknown): string {
  const list = Array.isArray(sizes) ? sizes.map(Number) : [];
  return list.length > 0 ? `${Math.min(...list)}-${Math.max(...list)}` : "";
}

const STOCK = { in_stock: [4, 9, 6, 12, 3, 7], out_of_stock: [0], unknown: [] } as const;

async function shoeCatalog() {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Catalog");
  sheet.addRow(["Qadam Shoes price list, November"]);
  sheet.addRow([]);
  sheet.addRow([
    "Name",
    "Category",
    "Brand",
    "Gender",
    "Color",
    "Sizes",
    "Material",
    "Price, ₸",
    "Stock",
  ]);
  (shoeStoreModel.offers ?? []).forEach((offer, i) => {
    const a = offer.attributes ?? {};
    const stock = STOCK[offer.availability ?? "unknown"];
    sheet.addRow([
      offer.title,
      offer.category,
      a.brand,
      a.gender,
      a.color,
      sizeRange(a.sizes),
      a.material,
      offer.price ?? "on request",
      stock.length > 0 ? stock[i % stock.length] : "",
    ]);
  });
  sheet.getColumn(1).width = 38;
  await book.xlsx.writeFile(path.join(OUT, "shoe-catalog.xlsx"));
}

/** A one-page PDF with plain Helvetica text lines. */
function simplePdf(lines: string[]): Buffer {
  const escape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const body = lines
    .map((line, i) => `${i === 0 ? "" : "0 -18 Td "}(${escape(line)}) Tj`)
    .join("\n");
  const stream = `BT /F1 11 Tf 56 780 Td\n${body}\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

async function storeTerms() {
  const lines = [
    "Qadam Shoes - store terms",
    "",
    "Qadam Shoes is a shoe shop on Furmanov Street 110, Almaty.",
    "Phone: +7 727 261 40 85. WhatsApp: +7 707 261 40 85. Instagram: @qadam.shoes.almaty",
    "",
    "Opening hours: every day 10:00-21:00.",
    "",
    "Delivery: free courier delivery in Almaty for orders over 50,000 KZT, otherwise 1,500 KZT.",
    "Delivery to other cities in Kazakhstan takes 3-5 days.",
    "",
    "Payment: cash, Kaspi QR, Kaspi Red installments and bank cards in the store.",
    "",
    "Returns: unworn shoes with the original box and receipt can be returned within 14 days.",
  ];
  await writeFile(path.join(OUT, "store-terms.pdf"), simplePdf(lines));
}

async function barbershopPrices() {
  const quote = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [["Service", "Category", "Duration, min", "Price, KZT", "Description"]];
  for (const offer of barbershopModel.offers ?? []) {
    const a = offer.attributes ?? {};
    rows.push([
      offer.title,
      offer.category ?? "",
      String(a.duration_minutes ?? ""),
      offer.price === null || offer.price === undefined ? "on request" : String(offer.price),
      offer.description ?? "",
    ]);
  }
  const csv = rows.map((r) => r.map(quote).join(";")).join("\n");
  await writeFile(path.join(OUT, "barbershop-prices.csv"), `${csv}\n`, "utf8");
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await Promise.all([shoeCatalog(), storeTerms(), barbershopPrices()]);
  console.log(`Wrote demo files to ${OUT}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
