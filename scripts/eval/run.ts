/**
 * Runs the shopper-agent evaluation against a local dev server over MCP.
 *
 *   pnpm eval [-- --config A,B,C --runs 3 --limit 10 --lang ru --out scripts/eval/out/<date>]
 *
 * The shopper model is the main tier of server/llm (temperature 0). Customer keys come from
 * EVAL_CUSTOMER_KEY, or EVAL_CUSTOMER_KEY_STRIDE_SHOES / EVAL_CUSTOMER_KEY_FADE_FACTORY per store.
 */
import "dotenv/config";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { createDb, type DbHandle } from "@/db/client";
import { llmUsage, tenants } from "@/db/schema";
import { getLlmClient, LlmError } from "@/server/llm";
import type { LlmClient, LlmMessage, LlmTool } from "@/server/llm";
import { writeReport } from "./report";
import { parseAnswer, type ConfigName, type RunRecord } from "./score";
import { evalDir, readQueries, type QuerySpec } from "./shared";

const RAW = ["search_offers", "get_offer_details", "check_availability", "compare_offers"];

const CONFIG_TOOLS: Record<ConfigName, string[]> = {
  A: [...RAW, "get_business_info"],
  B: ["find_offers", "get_business_info"],
  C: ["find_offers", ...RAW, "get_business_info", "report_answer"],
};

const MAX_STEPS = 8;
const MAX_TOOL_RESULT_CHARS = 12_000;

function shopperPrompt(storeSlug: string): string {
  return `You are a shopping agent acting for a customer of the online store "${storeSlug}". Find what the customer asks for with the tools and answer.

Rules:
- Every fact (offer ids, prices, availability, policies) must come from tool results. Never guess or invent them.
- Prices and availability can be unknown or "on request". Report them as they are and never state a price for such an offer.
- Answer in the language of the customer's message.

When you are done, reply with one JSON object and nothing else:
{"action": "answer" | "inquiry" | "clarify", "offers": [{"offer_id": "<id>", "price": <number or null>, "availability": "in_stock" | "out_of_stock" | "unknown" | null}], "answer": "<short reply to the customer>"}

- action "answer": the tool results are enough to answer the customer.
- action "inquiry": the customer needs something only the store can confirm (a price on request, unknown availability, a discount or a special request), so a message must be sent to the store.
- action "clarify": the request is too vague to search and you need to ask the customer a question.
- Offers with several sizes are grouped by model. Use the offer_id of the size the customer asked for (variant_ids or variants), or the listed offer_id when no size was asked, and quote that offer's price.
- offers: the best offers first, at most 5. Put a price or availability in an offer only when a tool returned it, otherwise null. Use [] when no offer is relevant.`;
}

function customerKey(store: string): string {
  const specific =
    process.env[`EVAL_CUSTOMER_KEY_${store.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
  const key = specific || process.env.EVAL_CUSTOMER_KEY;
  if (!key) {
    throw new Error(
      `No customer key for ${store}: set EVAL_CUSTOMER_KEY or EVAL_CUSTOMER_KEY_${store.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`,
    );
  }
  return key;
}

function resultText(result: CallToolResult): string {
  const text = result.content
    .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
    .join("\n");
  return text.length > MAX_TOOL_RESULT_CHARS
    ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[truncated]`
    : text;
}

async function connect(baseUrl: string, store: string): Promise<Client> {
  const client = new Client({ name: "eval-shopper", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/customer/${store}`), {
    requestInit: { headers: { Authorization: `Bearer ${customerKey(store)}` } },
  });
  await client.connect(transport);
  return client;
}

interface Dialog {
  content: string | null;
  toolCalls: string[];
  reports: string[];
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  error?: string;
}

async function converse(
  llm: LlmClient,
  client: Client,
  tools: LlmTool[],
  system: string,
  query: string,
): Promise<Dialog> {
  const messages: LlmMessage[] = [
    { role: "system", content: system },
    { role: "user", content: query },
  ];
  const dialog: Dialog = {
    content: null,
    toolCalls: [],
    reports: [],
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
  };
  for (let step = 0; step < MAX_STEPS; step++) {
    let response;
    try {
      response = await llm.chat({ messages, tools, temperature: 0 });
    } catch (error) {
      if (!(error instanceof LlmError)) throw error;
      dialog.error = `${error.kind}: ${error.message}`;
      return dialog;
    }
    dialog.promptTokens += response.usage?.promptTokens ?? 0;
    dialog.completionTokens += response.usage?.completionTokens ?? 0;
    dialog.cachedTokens += response.usage?.cachedTokens ?? 0;
    if (response.toolCalls.length === 0) {
      dialog.content = response.content;
      return dialog;
    }
    messages.push({ role: "assistant", content: response.content, toolCalls: response.toolCalls });
    for (const call of response.toolCalls) {
      dialog.toolCalls.push(call.name);
      if (call.name === "report_answer" && typeof call.arguments.verdict === "string") {
        dialog.reports.push(call.arguments.verdict);
      }
      let text: string;
      try {
        text = resultText(
          (await client.callTool({ name: call.name, arguments: call.arguments })) as CallToolResult,
        );
      } catch (error) {
        text = `error: ${(error as Error).message}`;
      }
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: text });
    }
  }
  dialog.error = "step_limit";
  return dialog;
}

async function internalUsage(
  handle: DbHandle | null,
  slug: string,
  from: Date,
  to: Date,
): Promise<{ input: number; output: number }> {
  if (!handle) return { input: 0, output: 0 };
  try {
    const [row] = await handle.db
      .select({
        input: sql<number>`coalesce(sum(${llmUsage.inputTokens}), 0)::int`,
        output: sql<number>`coalesce(sum(${llmUsage.outputTokens}), 0)::int`,
      })
      .from(llmUsage)
      .innerJoin(tenants, eq(tenants.id, llmUsage.tenantId))
      .where(
        and(eq(tenants.slug, slug), gte(llmUsage.createdAt, from), lte(llmUsage.createdAt, to)),
      );
    return { input: row?.input ?? 0, output: row?.output ?? 0 };
  } catch {
    return { input: 0, output: 0 };
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== "--"),
    options: {
      config: { type: "string", default: "A,B,C" },
      runs: { type: "string", default: "3" },
      limit: { type: "string" },
      lang: { type: "string" },
      query: { type: "string" },
      out: { type: "string" },
      "base-url": { type: "string", default: process.env.EVAL_BASE_URL ?? "http://localhost:3000" },
    },
  });
  const configs = values.config!.split(",").map((c) => c.trim().toUpperCase()) as ConfigName[];
  for (const c of configs) if (!(c in CONFIG_TOOLS)) throw new Error(`Unknown config ${c}`);
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  const baseUrl = values["base-url"]!.replace(/\/+$/, "");

  let queries: QuerySpec[] = readQueries();
  if (values.lang) queries = queries.filter((q) => q.lang === values.lang);
  if (values.query) queries = queries.filter((q) => q.id === values.query);
  if (values.limit) queries = queries.slice(0, Number(values.limit));
  if (queries.length === 0) throw new Error("No queries selected");

  const outDir = resolve(values.out ?? join(evalDir, "out", today()));
  mkdirSync(outDir, { recursive: true });
  const runsFile = join(outDir, "runs.jsonl");
  writeFileSync(runsFile, "");

  const llm = getLlmClient("main");
  const url = process.env.DATABASE_URL;
  const handle = url ? createDb(url) : null;
  const clients = new Map<string, { client: Client; tools: LlmTool[] }>();

  async function session(config: ConfigName, store: string) {
    const key = `${config}:${store}`;
    const cached = clients.get(key);
    if (cached) return cached;
    const client = await connect(baseUrl, store);
    const listed = (await client.listTools()).tools.filter((t) =>
      CONFIG_TOOLS[config].includes(t.name),
    );
    const missing = CONFIG_TOOLS[config].filter((name) => !listed.some((t) => t.name === name));
    if (missing.length > 0) throw new Error(`Server does not offer: ${missing.join(", ")}`);
    const entry = {
      client,
      tools: listed.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        parameters: t.inputSchema as Record<string, unknown>,
      })),
    };
    clients.set(key, entry);
    return entry;
  }

  let done = 0;
  const total = queries.length * configs.length * runs;
  try {
    for (const spec of queries) {
      for (const config of configs) {
        const { client, tools } = await session(config, spec.store);
        for (let run = 1; run <= runs; run++) {
          const started = new Date();
          const t0 = performance.now();
          let dialog: Dialog;
          try {
            dialog = await converse(llm, client, tools, shopperPrompt(spec.store), spec.query);
          } catch (error) {
            dialog = {
              content: null,
              toolCalls: [],
              reports: [],
              promptTokens: 0,
              completionTokens: 0,
              cachedTokens: 0,
              error: (error as Error).message,
            };
          }
          const latencyMs = Math.round(performance.now() - t0);
          const internal = await internalUsage(handle, spec.store, started, new Date());
          const record: RunRecord = {
            queryId: spec.id,
            config,
            run,
            answer: parseAnswer(dialog.content),
            toolCalls: dialog.toolCalls,
            reports: dialog.reports,
            promptTokens: dialog.promptTokens,
            completionTokens: dialog.completionTokens,
            cachedTokens: dialog.cachedTokens,
            internalInputTokens: internal.input,
            internalOutputTokens: internal.output,
            latencyMs,
            ...(dialog.error ? { error: dialog.error } : {}),
          };
          appendFileSync(runsFile, `${JSON.stringify({ ...record, raw: dialog.content })}\n`);
          done++;
          console.log(
            `[${done}/${total}] ${spec.id} ${config} run ${run}${dialog.error ? ` (${dialog.error})` : ""}`,
          );
        }
      }
    }
  } finally {
    await Promise.all([...clients.values()].map((c) => c.client.close()));
    await handle?.close();
  }

  const files = writeReport(outDir);
  console.log(`Report: ${files.join(", ")}`);
}

await main();
