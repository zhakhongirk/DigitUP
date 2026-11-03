/**
 * Scores a finished run and writes report.md, report.html and scores.json beside it.
 *
 *   pnpm eval:report [-- scripts/eval/out/<date>]
 *
 * EVAL_PRICE_INPUT and EVAL_PRICE_OUTPUT (USD per million tokens) enable the cost column.
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregate,
  costPer1000,
  groupBy,
  rawFallbackAccuracy,
  scoreRun,
  type Aggregate,
  type ConfigName,
  type Fact,
  type RunRecord,
  type RunScore,
} from "./score";
import { evalDir, readCatalog, readGold, readJsonl } from "./shared";

const CONFIGS: ConfigName[] = ["A", "B", "C"];
const CONFIG_LABEL: Record<ConfigName, string> = {
  A: "A raw tools",
  B: "B find_offers",
  C: "C find_offers + raw",
};

export interface Table {
  title: string;
  head: string[];
  rows: string[][];
}

const pct = (v: number | null): string => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
const num = (v: number): string => Math.round(v).toLocaleString("en-US");

function price(): { inputPerMillion: number; outputPerMillion: number } | null {
  const input = Number(process.env.EVAL_PRICE_INPUT);
  const output = Number(process.env.EVAL_PRICE_OUTPUT);
  return Number.isFinite(input) && Number.isFinite(output) && input > 0 && output > 0
    ? { inputPerMillion: input, outputPerMillion: output }
    : null;
}

function cost(a: Aggregate): string {
  const value = costPer1000({ input: a.inputMean, output: a.outputMean }, price());
  return value === null ? "n/a" : `$${value.toFixed(2)}`;
}

export function buildTables(scores: RunScore[]): Table[] {
  const byConfig = groupBy(scores, (s) => s.config);
  const present = CONFIGS.filter((c) => byConfig.has(c));
  const agg = (list: RunScore[], config: ConfigName) => aggregate(list, config);

  const summary: Table = {
    title: "Overall",
    head: [
      "Config",
      "Runs",
      "Accuracy",
      "Recall@5",
      "Confident errors",
      "Closed without human",
      "Handed to store",
      "Tokens/query p50",
      "Tokens/query p95",
      "Cached tokens/query",
      "USD per 1000",
      "Tool calls",
      "Latency p50 ms",
      "Latency p95 ms",
      "Raw fallback",
    ],
    rows: present.map((config) => {
      const a = agg(byConfig.get(config) ?? [], config);
      return [
        CONFIG_LABEL[config],
        String(a.runs),
        pct(a.accuracy),
        pct(a.recallAt5),
        pct(a.confidentErrors),
        pct(a.closedWithoutHuman),
        pct(a.handedOver),
        num(a.tokensP50),
        num(a.tokensP95),
        num(a.cachedMean),
        cost(a),
        a.toolCallsMean.toFixed(1),
        num(a.latencyP50),
        num(a.latencyP95),
        a.rawFallback === null ? "n/a" : pct(a.rawFallback),
      ];
    }),
  };

  const split = (title: string, key: (s: RunScore) => string): Table => {
    const keys = [...new Set(scores.map(key))].sort();
    return {
      title,
      head: [title.replace("By ", ""), ...present.flatMap((c) => [`${c} accuracy`, `${c} errors`])],
      rows: keys.map((k) => [
        k,
        ...present.flatMap((config) => {
          const list = scores.filter((s) => s.config === config && key(s) === k);
          const a = agg(list, config);
          return [pct(a.accuracy), pct(a.confidentErrors)];
        }),
      ]),
    };
  };

  const tables = [
    summary,
    split("By language", (s) => s.lang),
    split("By category", (s) => s.category),
  ];

  if (byConfig.has("C")) {
    const c = agg(byConfig.get("C") ?? [], "C");
    const fallback = rawFallbackAccuracy(scores);
    tables.push({
      title: "Config C raw fallback",
      head: [
        "Raw fallback rate",
        "Wrong reports",
        "Queries with fallback",
        "A accuracy there",
        "B accuracy there",
        "C accuracy there",
      ],
      rows: [
        [
          pct(c.rawFallback),
          pct(c.wrongReport),
          String(fallback.queries),
          pct(fallback.accuracy.A ?? null),
          pct(fallback.accuracy.B ?? null),
          pct(fallback.accuracy.C ?? null),
        ],
      ],
    });
  }
  return tables;
}

export function toMarkdown(tables: Table[], heading: string): string {
  const blocks = tables.map((table) =>
    [
      `## ${table.title}`,
      "",
      `| ${table.head.join(" | ")} |`,
      `| ${table.head.map(() => "---").join(" | ")} |`,
      ...table.rows.map((row) => `| ${row.join(" | ")} |`),
    ].join("\n"),
  );
  return `# ${heading}\n\n${blocks.join("\n\n")}\n`;
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function toHtml(tables: Table[], heading: string): string {
  const body = tables
    .map(
      (table) => `<h2>${escapeHtml(table.title)}</h2>
<table>
<thead><tr>${table.head.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
<tbody>
${table.rows.map((row) => `<tr>${row.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("\n")}
</tbody>
</table>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)}</title>
<style>
body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 1200px; padding: 0 1rem; color: #1a1a1a; }
table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
th, td { border: 1px solid #d0d0d0; padding: 6px 10px; text-align: right; }
th:first-child, td:first-child { text-align: left; }
thead { background: #f2f2f2; }
</style>
</head>
<body>
<h1>${escapeHtml(heading)}</h1>
${body}
</body>
</html>
`;
}

export function loadScores(outDir: string): { scores: RunScore[]; skipped: number } {
  const records = readJsonl<RunRecord>(join(outDir, "runs.jsonl"));
  const gold = new Map(readGold().map((g) => [g.id, g]));
  const stores = readCatalog();
  const scores: RunScore[] = [];
  let skipped = 0;
  for (const record of records) {
    const g = gold.get(record.queryId);
    if (!g) {
      skipped++;
      continue;
    }
    const catalog: Record<string, Fact> = stores[g.store] ?? {};
    scores.push(scoreRun(record, { gold: g, catalog }));
  }
  return { scores, skipped };
}

/** Writes the report files for a run directory and returns their paths. */
export function writeReport(outDir: string): string[] {
  const { scores } = loadScores(outDir);
  const heading = `Eval ${outDir.split(/[\\/]/).pop()}`;
  const tables = buildTables(scores);
  const files = [
    join(outDir, "report.md"),
    join(outDir, "report.html"),
    join(outDir, "scores.json"),
  ];
  writeFileSync(files[0]!, toMarkdown(tables, heading));
  writeFileSync(files[1]!, toHtml(tables, heading));
  writeFileSync(files[2]!, `${JSON.stringify(scores, null, 2)}\n`);
  return files;
}

function latestRunDir(): string {
  const root = join(evalDir, "out");
  const dirs = existsSync(root)
    ? readdirSync(root).filter((d) => existsSync(join(root, d, "runs.jsonl")))
    : [];
  const latest = dirs.sort().pop();
  if (!latest) throw new Error("No runs found; run pnpm eval first");
  return join(root, latest);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const dirArg = process.argv.slice(2).find((arg) => arg !== "--");
  const dir = dirArg ? resolve(dirArg) : latestRunDir();
  console.log(writeReport(dir).join("\n"));
}
