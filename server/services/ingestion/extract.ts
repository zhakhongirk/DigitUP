import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { extractText as extractPdfText, getDocumentProxy } from "unpdf";
import { inspectZip } from "./zip-guard";

export type SourceKind = "xlsx" | "csv" | "pdf" | "docx" | "txt";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const MAX_TEXT_CHARS = 200_000;

function assertSafeZip(bytes: Uint8Array, tooLarge: string, unreadable: string): void {
  const verdict = inspectZip(bytes);
  if (verdict === "too-large") throw new ExtractionError(tooLarge);
  if (verdict === "unreadable") throw new ExtractionError(unreadable);
}

export interface ExtractedTable {
  name: string;
  /** rows[0] is the header row as found in the file. */
  rows: string[][];
}

export interface Extraction {
  text: string;
  tables: ExtractedTable[];
}

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}

const EXTENSIONS: Record<string, SourceKind> = {
  xlsx: "xlsx",
  csv: "csv",
  pdf: "pdf",
  docx: "docx",
  txt: "txt",
  md: "txt",
};

/** Kind from the file name extension, or null when unsupported. */
export function detectKind(filename: string): SourceKind | null {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return null;
  return (
    EXTENSIONS[
      filename
        .slice(dot + 1)
        .trim()
        .toLowerCase()
    ] ?? null
  );
}

/** Throws ExtractionError with a short human-readable message on corrupt or unsupported input. */
export async function extractText(kind: SourceKind, bytes: Uint8Array): Promise<Extraction> {
  switch (kind) {
    case "xlsx":
      return fromTables(await readWorkbook(bytes), true);
    case "csv":
      return fromTables([{ name: "csv", rows: parseCsv(decodeUtf8(bytes)) }], false);
    case "pdf":
      return { text: await readPdf(bytes), tables: [] };
    case "docx":
      return { text: await readDocx(bytes), tables: [] };
    case "txt":
      return { text: normalise(decodeUtf8(bytes)), tables: [] };
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
}

function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

function fromTables(tables: ExtractedTable[], withHeading: boolean): Extraction {
  const blocks = tables.map((table) => {
    const lines = table.rows.map((row) => row.join(" | "));
    return (withHeading ? [`Sheet: ${table.name}`, ...lines] : lines).join("\n");
  });
  return { text: normalise(blocks.join("\n\n")), tables };
}

function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if ("richText" in value) return value.richText.map((part) => part.text).join("");
  if ("formula" in value || "sharedFormula" in value) {
    return cellToString(value.result as ExcelJS.CellValue);
  }
  if ("hyperlink" in value) return cellToString(value.text);
  if ("error" in value) return value.error;
  return "";
}

async function readWorkbook(bytes: Uint8Array): Promise<ExtractedTable[]> {
  assertSafeZip(bytes, "The spreadsheet is too large to read.", "Could not read the spreadsheet.");
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as ExcelJS.Buffer);
    const tables: ExtractedTable[] = [];
    workbook.eachSheet((sheet) => {
      const rows: string[][] = [];
      sheet.eachRow({ includeEmpty: false }, (row) => {
        const cells: string[] = [];
        for (let col = 1; col <= row.cellCount; col++) {
          cells.push(cellToString(row.getCell(col).value).trim());
        }
        while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
        if (cells.length > 0) rows.push(cells);
      });
      tables.push({ name: sheet.name, rows });
    });
    return tables;
  } catch {
    throw new ExtractionError("Could not read the spreadsheet.");
  }
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  let best = ",";
  let bestCount = 0;
  for (const candidate of [",", ";", "\t"]) {
    const count = firstLine.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

function parseCsv(text: string): string[][] {
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const endRow = () => {
    row.push(field.trim());
    field = "";
    while (row.length > 0 && row[row.length - 1] === "") row.pop();
    if (row.length > 0) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(field.trim());
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else field += ch;
  }
  endRow();
  return rows;
}

async function readPdf(bytes: Uint8Array): Promise<string> {
  let text: string;
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    text = (await extractPdfText(pdf, { mergePages: true })).text;
  } catch {
    throw new ExtractionError("Could not read the PDF.");
  }
  const normalised = normalise(text);
  if (!normalised) {
    throw new ExtractionError("No text found in the PDF. Scanned documents are not supported yet.");
  }
  return normalised;
}

async function readDocx(bytes: Uint8Array): Promise<string> {
  assertSafeZip(
    bytes,
    "The Word document is too large to read.",
    "Could not read the Word document.",
  );
  try {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return normalise(result.value);
  } catch {
    throw new ExtractionError("Could not read the Word document.");
  }
}
