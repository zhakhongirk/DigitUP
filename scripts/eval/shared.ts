import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Action, Fact, Gold } from "./score";

export const evalDir = dirname(fileURLToPath(import.meta.url));

export interface QuerySpec {
  id: string;
  lang: string;
  category: string;
  store: string;
  query: string;
  must: string[];
  ok: string[];
  forbidden: string[];
  action: Action;
  text_any?: string[];
  notes?: string;
}

export function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

export function readQueries(): QuerySpec[] {
  return readJsonl<QuerySpec>(join(evalDir, "queries.jsonl"));
}

export function readGold(): Gold[] {
  const path = join(evalDir, "gold.jsonl");
  if (!existsSync(path)) throw new Error("gold.jsonl is missing; run pnpm eval:gold");
  return readJsonl<Gold>(path);
}

export function readCatalog(): Record<string, Record<string, Fact>> {
  const path = join(evalDir, "catalog.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}
