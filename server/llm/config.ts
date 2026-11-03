import { z } from "zod";

export const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

const llmEnvSchema = z.object({
  apiKey: z.string({ error: "LLM_API_KEY is required" }).min(1, "LLM_API_KEY is required"),
  model: z.string({ error: "LLM_MODEL is required" }).min(1, "LLM_MODEL is required"),
  baseURL: z.url().default(FIREWORKS_BASE_URL),
  LLM_TOOL_CALL_MODE: z.enum(["native", "json"]).default("native"),
  LLM_JSON_RESPONSE_FORMAT: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  LLM_REASONING_EFFORT: z.enum(REASONING_EFFORTS).optional(),
  LLM_REASONING_TOKENS: z.coerce.number().int().min(0).default(0),
});

export interface LlmConfig {
  apiKey: string;
  model: string;
  baseURL: string;
  mode: "native" | "json";
  jsonResponseFormat: boolean;
  reasoningEffort?: ReasoningEffort;
  reasoningTokens: number;
}

type Env = Record<string, string | undefined>;

function pick(env: Env, primary: string, legacy: string): string | undefined {
  return env[primary] || env[legacy] || undefined;
}

/** True when an API key and a model are set under either the LLM_* or the legacy FIREWORKS_* names. */
export function isLlmConfigured(env: Env = process.env): boolean {
  return Boolean(
    pick(env, "LLM_API_KEY", "FIREWORKS_API_KEY") && pick(env, "LLM_MODEL", "FIREWORKS_MODEL"),
  );
}

export function readLlmModel(env: Env = process.env): string | undefined {
  return pick(env, "LLM_MODEL", "FIREWORKS_MODEL");
}

export function readLlmConfig(env: Env = process.env): LlmConfig {
  const parsed = llmEnvSchema.safeParse({
    apiKey: pick(env, "LLM_API_KEY", "FIREWORKS_API_KEY"),
    model: pick(env, "LLM_MODEL", "FIREWORKS_MODEL"),
    baseURL: pick(env, "LLM_BASE_URL", "FIREWORKS_BASE_URL"),
    LLM_TOOL_CALL_MODE: env.LLM_TOOL_CALL_MODE || undefined,
    LLM_JSON_RESPONSE_FORMAT: env.LLM_JSON_RESPONSE_FORMAT || undefined,
    LLM_REASONING_EFFORT: env.LLM_REASONING_EFFORT || undefined,
    LLM_REASONING_TOKENS: env.LLM_REASONING_TOKENS || undefined,
  });
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Invalid LLM configuration: ${problems}`);
  }
  const value = parsed.data;
  return {
    apiKey: value.apiKey,
    model: value.model,
    baseURL: value.baseURL,
    mode: value.LLM_TOOL_CALL_MODE,
    jsonResponseFormat: value.LLM_JSON_RESPONSE_FORMAT,
    ...(value.LLM_REASONING_EFFORT ? { reasoningEffort: value.LLM_REASONING_EFFORT } : {}),
    reasoningTokens: value.LLM_REASONING_TOKENS,
  };
}
