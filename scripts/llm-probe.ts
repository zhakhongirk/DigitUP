/**
 * Probes the configured model for the capabilities the agents rely on
 * and writes a report to docs/llm-probe.md.
 *
 *   pnpm llm:probe [-- --tier fast|main|heavy]
 *
 * Requires LLM_API_KEY and LLM_MODEL, read from .env.
 * LLM_REASONING_EFFORT and LLM_REASONING_TOKENS apply to every probe call.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import OpenAI from "openai";
import { createLlmClient, type ChatCompletionsApi } from "@/server/llm/client";
import { LLM_TIERS, readTierConfig } from "@/server/llm/config";
import type { LlmTier } from "@/server/llm/types";
import type { LlmClient, LlmTool } from "@/server/llm/types";

const RUNS = 3;
let reasoningTokens = 0;
let completionTokens = 0;

interface CheckResult {
  name: string;
  passed: number;
  runs: number;
  avgMs: number;
  notes: string[];
}

const weatherTool: LlmTool = {
  name: "get_weather",
  description: "Get the current weather for a city",
  parameters: {
    type: "object",
    properties: { city: { type: "string", description: "City name" } },
    required: ["city"],
  },
};

async function runCheck(
  name: string,
  runs: number,
  attempt: () => Promise<{ ok: boolean; note: string }>,
): Promise<CheckResult> {
  const result: CheckResult = { name, passed: 0, runs, avgMs: 0, notes: [] };
  let totalMs = 0;
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    try {
      const { ok, note } = await attempt();
      if (ok) result.passed++;
      result.notes.push(`${ok ? "ok" : "fail"}: ${note}`);
    } catch (error) {
      result.notes.push(`error: ${(error as Error).message}`);
    }
    totalMs += performance.now() - started;
  }
  result.avgMs = Math.round(totalMs / runs);
  console.log(`${name}: ${result.passed}/${runs} (avg ${result.avgMs} ms)`);
  return result;
}

const short = (text: string | null) => JSON.stringify((text ?? "").slice(0, 160));

/** A solid red 32x32 PNG, built in code so the probe has no file or network dependency. */
function redSquarePng(): string {
  const size = 32;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([220, 20, 20]))]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));

  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // color type: RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

function readTier(): LlmTier {
  const index = process.argv.indexOf("--tier");
  const value = index >= 0 ? process.argv[index + 1] : "main";
  if (!LLM_TIERS.includes(value as LlmTier)) {
    throw new Error(`--tier must be one of ${LLM_TIERS.join(", ")}`);
  }
  return value as LlmTier;
}

async function main() {
  const tier = readTier();
  const config = readTierConfig(tier);
  if (!config) throw new Error(`No usable settings for the ${tier} tier`);
  const REPORT_PATH = resolve(tier === "main" ? "docs/llm-probe.md" : `docs/llm-probe-${tier}.md`);
  const openai = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  const completions: ChatCompletionsApi = {
    async create(params) {
      const completion = await openai.chat.completions.create(params);
      const usage = completion.usage;
      completionTokens += usage?.completion_tokens ?? 0;
      reasoningTokens += usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      return completion;
    },
  };
  const build = (
    mode: "native" | "json",
    jsonResponseFormat = config.jsonResponseFormat,
  ): LlmClient =>
    createLlmClient({
      model: config.model,
      mode,
      jsonResponseFormat,
      reasoningEffort: config.reasoningEffort,
      reasoningTokens: config.reasoningTokens,
      completions,
    });
  const native = build("native");
  const jsonTools = (jsonResponseFormat: boolean): LlmClient => build("json", jsonResponseFormat);

  console.log(`Probing ${tier} tier: ${config.model} at ${config.baseURL} (reasoning_effort=${config.reasoningEffort ?? "default"}, headroom=${config.reasoningTokens})
`);

  const plain = await runCheck("Plain chat", 1, async () => {
    const reply = await native.chat({
      messages: [{ role: "user", content: "Reply with exactly the word PONG and nothing else." }],
      temperature: 0,
      maxTokens: 20,
    });
    return { ok: /PONG/i.test(reply.content ?? ""), note: short(reply.content) };
  });

  const toolPrompt = {
    messages: [
      { role: "system" as const, content: "You are an assistant. Use tools when they help." },
      { role: "user" as const, content: "What is the weather in Almaty right now?" },
    ],
    tools: [weatherTool],
    temperature: 0,
    maxTokens: 300,
  };
  const toolCallOk = (call: { name: string; arguments: Record<string, unknown> } | undefined) =>
    call?.name === "get_weather" && /almaty/i.test(String(call.arguments.city ?? ""));

  const nativeTools = await runCheck("Native tool calling", RUNS, async () => {
    const reply = await native.chat(toolPrompt);
    const call = reply.toolCalls[0];
    return {
      ok: toolCallOk(call),
      note: call
        ? `${call.name}(${JSON.stringify(call.arguments)})`
        : `text ${short(reply.content)}`,
    };
  });

  // Second turn: the model must use a tool result instead of calling again.
  const nativeRoundTrip = await runCheck("Native tool result round trip", 1, async () => {
    const reply = await native.chat({
      ...toolPrompt,
      messages: [
        ...toolPrompt.messages,
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "call_probe", name: "get_weather", arguments: { city: "Almaty" } }],
        },
        {
          role: "tool",
          toolCallId: "call_probe",
          name: "get_weather",
          content: '{"city":"Almaty","temperature_c":7,"condition":"light snow"}',
        },
      ],
    });
    return {
      ok: reply.toolCalls.length === 0 && /7|snow/i.test(reply.content ?? ""),
      note: short(reply.content),
    };
  });

  const jsonMode = await runCheck("JSON mode (response_format json_object)", 1, async () => {
    const reply = await native.chat({
      messages: [
        {
          role: "user",
          content: 'Return a JSON object {"city": string, "country": string} for Almaty.',
        },
      ],
      responseFormat: "json",
      temperature: 0,
      maxTokens: 100,
    });
    const value = JSON.parse(reply.content ?? "") as Record<string, unknown>;
    return { ok: typeof value.country === "string", note: short(reply.content) };
  });

  const jsonFallback = await runCheck("JSON tool-call fallback", RUNS, async () => {
    const reply = await jsonTools(jsonMode.passed > 0).chat(toolPrompt);
    const call = reply.toolCalls[0];
    return {
      ok: toolCallOk(call),
      note: call
        ? `${call.name}(${JSON.stringify(call.arguments)})`
        : `text ${short(reply.content)}`,
    };
  });

  const image = await runCheck("Image input", 1, async () => {
    const reply = await native.chat({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is the main color of this image? Answer with one word." },
            { type: "image", url: redSquarePng() },
          ],
        },
      ],
      temperature: 0,
      maxTokens: 20,
    });
    return { ok: /red/i.test(reply.content ?? ""), note: short(reply.content) };
  });

  const checks = [plain, nativeTools, nativeRoundTrip, jsonMode, jsonFallback, image];

  const nativeReliable = nativeTools.passed === nativeTools.runs && nativeRoundTrip.passed === 1;
  const mode = nativeReliable ? "native" : jsonFallback.passed > 0 ? "json" : "none";
  const reasoningLines = [
    config.reasoningEffort ? `LLM_REASONING_EFFORT=${config.reasoningEffort}` : "",
    config.reasoningTokens > 0 ? `LLM_REASONING_TOKENS=${config.reasoningTokens}` : "",
  ].filter(Boolean);
  const toolMode =
    mode === "native"
      ? "LLM_TOOL_CALL_MODE=native"
      : mode === "json"
        ? `LLM_TOOL_CALL_MODE=json\nLLM_JSON_RESPONSE_FORMAT=${jsonMode.passed > 0}`
        : "No working tool-call mode found. Agents cannot run on this model; revisit the model choice.";
  const recommendation = [toolMode, ...reasoningLines].join("\n");

  const report = [
    "# LLM probe",
    "",
    `- Date: ${new Date().toISOString()}`,
    `- Tier: ${tier}`,
    `- Model: \`${config.model}\``,
    `- Endpoint: ${config.baseURL}`,
    `- Reasoning effort: ${config.reasoningEffort ?? "default"}, token headroom: ${config.reasoningTokens}`,
    `- Completion tokens: ${completionTokens}, of which reasoning: ${reasoningTokens}`,
    "",
    "| Check | Passed | Avg latency |",
    "|---|---|---|",
    ...checks.map((c) => `| ${c.name} | ${c.passed}/${c.runs} | ${c.avgMs} ms |`),
    "",
    "## Recommendation",
    "",
    "```",
    recommendation,
    "```",
    "",
    `Image input: ${image.passed > 0 ? "supported (offers can be extracted from photos)" : "not supported (photo extraction needs another model)"}.`,
    "",
    "## Raw results",
    "",
    ...checks.flatMap((c) => [`### ${c.name}`, "", ...c.notes.map((n) => `- ${n}`), ""]),
  ].join("\n");

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  console.log(`
Completion tokens: ${completionTokens}, reasoning tokens: ${reasoningTokens}`);
  writeFileSync(REPORT_PATH, report);
  console.log(`\nRecommendation:\n${recommendation}\n\nReport written to ${REPORT_PATH}`);
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
