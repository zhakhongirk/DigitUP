/**
 * Prepares an eval run: creates a customer-agent key for every store in queries.jsonl,
 * stores it in .env as EVAL_CUSTOMER_KEY_<STORE>, and checks that the keyed customer MCP
 * endpoint answers with the tools every config needs.
 *
 *   pnpm eval:setup                     # create keys, write .env, check the endpoint
 *   pnpm eval:setup -- --check          # only check the keys already in .env
 *   pnpm eval:setup -- --base-url <url> # check another server
 */
import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDb } from "@/db/client";
import { createTenancyService } from "@/server/services/tenancy";
import { readQueries } from "./shared";

const REQUIRED_TOOLS = [
  "find_offers",
  "get_business_info",
  "report_answer",
  "search_offers",
  "get_offer_details",
  "check_availability",
  "compare_offers",
];

export function envName(store: string): string {
  return `EVAL_CUSTOMER_KEY_${store.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export function upsertEnv(text: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  if (pattern.test(text)) return text.replace(pattern, line);
  return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`;
}

async function createKeys(stores: string[]): Promise<Record<string, string>> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const handle = createDb(url);
  try {
    const tenancy = createTenancyService(handle.db, {
      authSecret: process.env.AUTH_SECRET ?? "eval-setup-secret-key",
    });
    const keys: Record<string, string> = {};
    for (const store of stores) {
      const ctx = await tenancy.contextFromSlug(store, "system");
      if (!ctx) throw new Error(`Store ${store} not found or not live: run pnpm db:seed`);
      keys[store] = (await tenancy.createApiKey(ctx, "customer_agent")).key;
    }
    return keys;
  } finally {
    await handle.close();
  }
}

async function check(baseUrl: string, store: string, key: string): Promise<string> {
  const client = new Client({ name: "eval-setup", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/customer/${store}`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    const missing = REQUIRED_TOOLS.filter((name) => !names.includes(name));
    return missing.length ? `missing tools: ${missing.join(", ")}` : `ok, ${names.length} tools`;
  } catch (error) {
    return `failed: ${(error as Error).message}`;
  } finally {
    await client.close().catch(() => {});
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      check: { type: "boolean", default: false },
      "base-url": { type: "string", default: process.env.EVAL_BASE_URL ?? "http://localhost:3000" },
    },
    allowPositionals: true,
  });
  const stores = [...new Set(readQueries().map((query) => query.store))];
  const envPath = resolve(".env");

  if (!values.check) {
    const keys = await createKeys(stores);
    let text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    for (const [store, key] of Object.entries(keys)) {
      text = upsertEnv(text, envName(store), key);
      process.env[envName(store)] = key;
      console.log(`${envName(store)} written to .env`);
    }
    writeFileSync(envPath, text);
  }

  let failed = false;
  for (const store of stores) {
    const key = process.env[envName(store)] ?? process.env.EVAL_CUSTOMER_KEY;
    const result = key ? await check(values["base-url"], store, key) : "no key";
    if (!result.startsWith("ok")) failed = true;
    console.log(`${store}: ${result}`);
  }
  if (!process.env.LLM_API_KEY && !process.env.FIREWORKS_API_KEY) {
    console.log("LLM_API_KEY is not set: the shopper model cannot run");
    failed = true;
  }
  if (failed) process.exitCode = 1;
  else console.log("Ready: pnpm eval:gold, then pnpm eval -- --config B --runs 1 --limit 3");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
