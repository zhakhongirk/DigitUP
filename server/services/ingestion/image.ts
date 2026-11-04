import { getOptionalLlmClient, LlmError, type LlmClient } from "@/server/llm";
import { ExtractionError, type Extraction } from "./extract";

export interface ImageInput {
  tenantId: string;
  mime: string;
  bytes: Uint8Array;
}

/** Reads the text and tables of a photographed document. */
export type ImageReader = (input: ImageInput) => Promise<Extraction>;

const PROMPT = [
  "This is a photo or scan of a price list, catalog page or menu from a small business.",
  "Transcribe every product or service row exactly as written, in the original language.",
  "Reply with plain text only. First line: column names separated by ' | '.",
  "Then one line per row with the cells separated by ' | ', keeping prices as printed with their currency.",
  "If the image has headings, contacts, delivery or payment terms, add them after the rows as plain lines.",
  "Do not invent anything. If the image has no readable text, reply with exactly: NO_TEXT",
].join("\n");

const UNREADABLE = "Could not read any text from this photo. Try a sharper, well lit picture.";

export function parsePipeTable(text: string): string[][] {
  const rows = text
    .split("\n")
    .filter((line) => line.includes(" | "))
    .map((line) =>
      line.split(" | ").map((cell) =>
        cell
          .trim()
          .replace(/^\||\|$/g, "")
          .trim(),
      ),
    );
  const width = Math.max(0, ...rows.map((row) => row.length));
  return width >= 2 ? rows : [];
}

export function createImageReader(getClient: () => LlmClient | null): ImageReader {
  return async ({ tenantId, mime, bytes }) => {
    const client = getClient();
    if (!client) {
      throw new ExtractionError("Photos need the AI model, which is not configured.");
    }
    let content: string | null;
    try {
      const result = await client.chat({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: PROMPT },
              {
                type: "image",
                url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
              },
            ],
          },
        ],
        usageSource: { tenantId, surface: "onboarding" },
        maxTokens: 4000,
        temperature: 0,
      });
      content = result.content;
    } catch (error) {
      if (error instanceof LlmError) throw new ExtractionError("Could not read this photo.");
      throw error;
    }
    const text = (content ?? "").replace(/\r\n?/g, "\n").trim();
    if (text === "" || text === "NO_TEXT") throw new ExtractionError(UNREADABLE);
    const rows = parsePipeTable(text);
    return { text, tables: rows.length > 0 ? [{ name: "photo", rows }] : [] };
  };
}

export const defaultImageReader: ImageReader = (input) =>
  createImageReader(() => getOptionalLlmClient("heavy"))(input);
