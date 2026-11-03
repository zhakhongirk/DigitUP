import { z } from "zod";
import type { LlmTier } from "./types";

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

export const LLM_TIERS = ["main", "fast", "heavy"] as const satisfies readonly LlmTier[];

/**
 * Settings of one tier. "fast" and "heavy" read LLM_FAST_* / LLM_HEAVY_* and fall back to the
 * main settings value by value. The main API key is reused only when the tier sets no base URL,
 * so a key is never sent to a host it was not issued for. Returns null when the result is unusable.
 */
export function readTierConfig(tier: LlmTier, env: Env = process.env): LlmConfig | null {
  const main = isLlmConfigured(env) ? readLlmConfig(env) : null;
  if (tier === "main") return main;
  const prefix = `LLM_${tier.toUpperCase()}_`;
  const own = (name: string) => env[`${prefix}${name}`] || undefined;

  const baseURL = own("BASE_URL") ?? main?.baseURL;
  const apiKey = own("API_KEY") ?? (own("BASE_URL") ? undefined : main?.apiKey);
  const model = own("MODEL") ?? main?.model;
  if (!baseURL || !apiKey || !model) return null;

  const parsed = z
    .object({
      baseURL: z.url(),
      mode: z.enum(["native", "json"]).optional(),
      effort: z.enum(REASONING_EFFORTS).optional(),
      tokens: z.coerce.number().int().min(0).optional(),
    })
    .safeParse({
      baseURL,
      mode: own("TOOL_CALL_MODE"),
      effort: own("REASONING_EFFORT"),
      tokens: own("REASONING_TOKENS"),
    });
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Invalid ${tier} LLM configuration: ${problems}`);
  }
  const reasoningEffort = parsed.data.effort ?? main?.reasoningEffort;
  return {
    apiKey,
    model,
    baseURL: parsed.data.baseURL,
    mode: parsed.data.mode ?? main?.mode ?? "native",
    jsonResponseFormat: main?.jsonResponseFormat ?? true,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    reasoningTokens: parsed.data.tokens ?? main?.reasoningTokens ?? 0,
  };
}
