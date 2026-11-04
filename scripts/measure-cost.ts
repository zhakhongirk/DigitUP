/**
 * Measures what a short shopper dialog costs on the main tier.
 *
 *   pnpm cost:measure [-- --dialogs 12 --store stride-shoes --out scripts/eval/out/cost]
 *
 * Runs the storefront chat agent directly against the local database and the real model, then reads
 * the llm_usage rows written during the run. Prices come from LLM_PRICE_INPUT_PER_M and
 * LLM_PRICE_OUTPUT_PER_M (USD per million tokens). The daily token budget is switched off for the run.
 * Each dialog leaves a conversation (and, at most, a draft order) in the store.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { llmUsage } from "@/db/schema";
import { createCustomerAgent } from "@/server/agents/customer";
import { createServices } from "@/server/container";
import { RecordingEventPublisher } from "@/server/events/types";
import { getLlmClient, getOptionalLlmClient, LlmError, type LlmClient } from "@/server/llm";
import { createModelInterpreter } from "@/server/services/intent";

process.env.LLM_DAILY_TOKEN_BUDGET = "0";

type Lang = "en" | "ru" | "kk";

const DIALOGS: { lang: Lang; turns: string[] }[] = [
  {
    lang: "en",
    turns: [
      "Do you have black running shoes in size 42 under 40000 tenge?",
      "How long does delivery to Almaty take and how much is it?",
      "I would like to order the first one in size 42",
    ],
  },
  {
    lang: "ru",
    turns: [
      "Нужны белые кроссовки 40 размера до 30000 тенге",
      "А доставка в Астану есть? Сколько стоит?",
      "Хочу заказать, как оформить?",
    ],
  },
  {
    lang: "kk",
    turns: [
      "Қара етік 38 өлшем бар ма, 50000 теңгеге дейін?",
      "Жеткізу қанша уақытқа созылады?",
      "Тапсырыс бергім келеді",
    ],
  },
  {
    lang: "en",
    turns: [
      "Show me sandals for women, size 38, up to 20000",
      "Can I return them if they do not fit?",
    ],
  },
  {
    lang: "ru",
    turns: [
      "Есть кроссовки для бега, мужские, 43 размер, бюджет 45 тысяч",
      "Какие способы оплаты у вас есть?",
      "Беру второй вариант, оформите заказ",
    ],
  },
  {
    lang: "en",
    turns: [
      "Looking for kids shoes size 30, something cheap",
      "Do you deliver outside Almaty?",
      "Start an order for the cheapest one please",
    ],
  },
  {
    lang: "ru",
    turns: [
      "Покажите зимние ботинки женские 37 размер до 60000",
      "Есть ли они в наличии прямо сейчас?",
    ],
  },
  {
    lang: "kk",
    turns: [
      "Ерлерге арналған кроссовка 42 өлшем, 40000 теңгеге дейін",
      "Төлемді қалай жасауға болады?",
      "Алғашқысына тапсырыс беремін",
    ],
  },
  {
    lang: "en",
    turns: [
      "What brands of sneakers do you have in white, size 41?",
      "What are your working hours?",
    ],
  },
  {
    lang: "ru",
    turns: [
      "Мне нужны лоферы чёрные 44 размер",
      "Сколько идёт доставка и можно ли забрать самому?",
      "Оформите заказ на лоферы",
    ],
  },
  {
    lang: "kk",
    turns: ["Әйелдерге арналған балеткалар бар ма, 37 өлшем?", "Қайтару шарттары қандай?"],
  },
  {
    lang: "en",
    turns: [
      "I need trail running shoes, men, size 44, around 50000",
      "Do you accept cash on delivery?",
      "Order the cheapest trail pair in size 44",
    ],
  },
];

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

const avg = (values: number[]) =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

interface TurnResult {
  dialog: number;
  latencyMs: number;
  modelCalls: number;
  modelErrors: number;
  stoppedBy: string;
  from: Date;
  to: Date;
  input: number;
  output: number;
  cached: number;
}

async function dbNow(): Promise<Date> {
  const result = await getDb().execute<{ now: Date }>(sql`select clock_timestamp() as now`);
  return new Date(result.rows[0]!.now);
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      dialogs: { type: "string", default: "12" },
      store: { type: "string", default: "stride-shoes" },
      out: { type: "string", default: "scripts/eval/out/cost" },
    },
  });
  const count = Math.max(1, Number(values.dialogs) || 12);
  const store = values.store!;
  const db = getDb();
  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret) throw new Error("AUTH_SECRET is not set");

  const primary = getLlmClient("main");
  const fast = getOptionalLlmClient("fast");
  const services = createServices({
    db,
    events: new RecordingEventPublisher(),
    authSecret,
    interpret: async (ctx, input) => (fast ? createModelInterpreter(fast)(ctx, input) : null),
  });
  const ctx = await services.tenancy.contextFromSlug(store, "customer_agent");
  if (!ctx) throw new Error(`Store ${store} not found or not live`);

  let modelCalls = 0;
  let modelErrors = 0;
  const counted: LlmClient = {
    mode: primary.mode,
    model: primary.model,
    async chat(request) {
      modelCalls += 1;
      try {
        return await primary.chat(request);
      } catch (error) {
        if (error instanceof LlmError) modelErrors += 1;
        throw error;
      }
    },
  };
  const agent = createCustomerAgent({
    services,
    llm: counted,
    budget: { exceeded: async () => false },
  });

  const runStart = await dbNow();
  const turns: TurnResult[] = [];
  for (let d = 0; d < count; d++) {
    const dialog = DIALOGS[d % DIALOGS.length]!;
    const sessionKey = randomBytes(18).toString("base64url");
    for (let t = 0; t < dialog.turns.length; t++) {
      modelCalls = 0;
      modelErrors = 0;
      const from = await dbNow();
      const started = Date.now();
      let stoppedBy = "error";
      try {
        const result = await agent.reply({
          ctx,
          channel: "storefront",
          sessionKey,
          message: dialog.turns[t]!,
        });
        stoppedBy = result.stoppedBy;
      } catch (error) {
        console.error(`dialog ${d + 1} turn ${t + 1} failed:`, error);
      }
      const latencyMs = Date.now() - started;
      const to = await dbNow();
      turns.push({
        dialog: d,
        latencyMs,
        modelCalls,
        modelErrors,
        stoppedBy,
        from,
        to,
        input: 0,
        output: 0,
        cached: 0,
      });
      console.log(
        `dialog ${d + 1}/${count} turn ${t + 1}: ${latencyMs} ms, ${modelCalls} model calls, ${stoppedBy}`,
      );
    }
  }

  const rows = await db
    .select()
    .from(llmUsage)
    .where(and(eq(llmUsage.tenantId, ctx.tenantId), gte(llmUsage.createdAt, runStart)))
    .orderBy(asc(llmUsage.createdAt));
  for (const row of rows) {
    const turn = turns.find((t) => row.createdAt >= t.from && row.createdAt <= t.to);
    if (!turn) continue;
    turn.input += row.inputTokens;
    turn.output += row.outputTokens;
    turn.cached += row.cachedTokens ?? 0;
  }
  const attributed = turns.reduce((n, t) => n + t.input + t.output, 0);
  const total = rows.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0);

  const perDialog = Array.from({ length: count }, (_, d) => {
    const own = turns.filter((t) => t.dialog === d);
    return {
      input: own.reduce((n, t) => n + t.input, 0),
      output: own.reduce((n, t) => n + t.output, 0),
    };
  });
  const priceIn = Number(process.env.LLM_PRICE_INPUT_PER_M);
  const priceOut = Number(process.env.LLM_PRICE_OUTPUT_PER_M);
  const priced =
    !!process.env.LLM_PRICE_INPUT_PER_M &&
    !!process.env.LLM_PRICE_OUTPUT_PER_M &&
    Number.isFinite(priceIn) &&
    Number.isFinite(priceOut);
  const cost = (input: number, output: number) => (input * priceIn + output * priceOut) / 1_000_000;

  const stats = (label: string, items: { input: number; output: number }[]) => {
    const inp = items.map((i) => i.input);
    const out = items.map((i) => i.output);
    const sum = items.map((i) => i.input + i.output);
    const triple = (v: number[]) =>
      `${fmt(avg(v))} / ${fmt(percentile(v, 50))} / ${fmt(percentile(v, 90))}`;
    return `| ${label} | ${triple(inp)} | ${triple(out)} | ${triple(sum)} |`;
  };
  const lines = [
    "# Cost per dialog",
    "",
    `Store ${store}, model ${primary.model}, ${new Date().toISOString()}.`,
    "",
    `- Dialogs: ${count}, turns: ${turns.length}`,
    `- Usage rows read: ${rows.length} (${fmt(total)} tokens, ${fmt(attributed)} attributed to turns)`,
    `- Cached input tokens: ${fmt(turns.reduce((n, t) => n + t.cached, 0))}`,
    `- Average latency per turn: ${fmt(avg(turns.map((t) => t.latencyMs)))} ms (p90 ${fmt(
      percentile(
        turns.map((t) => t.latencyMs),
        90,
      ),
    )} ms)`,
    `- Turns that fell back to the rule-based assistant or ended on a model error: ${turns.filter((t) => t.modelErrors > 0 || t.stoppedBy === "llm_error").length}`,
    `- Main-tier model calls per turn: ${(turns.reduce((n, t) => n + t.modelCalls, 0) / turns.length).toFixed(1)}`,
    "",
    "| Per | Input avg / p50 / p90 | Output avg / p50 / p90 | Total avg / p50 / p90 |",
    "| --- | --- | --- | --- |",
    stats("dialog", perDialog),
    stats("turn", turns),
    "",
    priced
      ? `Estimated cost at ${priceIn} / ${priceOut} USD per 1M input / output tokens: ${cost(avg(perDialog.map((d) => d.input)), avg(perDialog.map((d) => d.output))).toFixed(5)} USD per dialog, ${cost(avg(turns.map((t) => t.input)), avg(turns.map((t) => t.output))).toFixed(5)} USD per turn.`
      : "Price unknown: set LLM_PRICE_INPUT_PER_M and LLM_PRICE_OUTPUT_PER_M (USD per 1M tokens) to get a cost estimate. Tokens only.",
    "",
  ];
  const text = lines.join("\n");
  console.log(`\n${text}`);
  const dir = resolve(values.out!);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `cost-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  writeFileSync(file, text);
  console.log(`Written to ${file}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
