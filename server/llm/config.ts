import { z } from "zod";

export const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";

const llmEnvSchema = z.object({
  FIREWORKS_API_KEY: z
    .string({ error: "FIREWORKS_API_KEY is required" })
    .min(1, "FIREWORKS_API_KEY is required"),
  FIREWORKS_MODEL: z
    .string({ error: "FIREWORKS_MODEL is required" })
    .min(1, "FIREWORKS_MODEL is required"),
  FIREWORKS_BASE_URL: z.url().default(FIREWORKS_BASE_URL),
  LLM_TOOL_CALL_MODE: z.enum(["native", "json"]).default("native"),
  LLM_JSON_RESPONSE_FORMAT: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});

export interface LlmConfig {
  apiKey: string;
  model: string;
  baseURL: string;
  mode: "native" | "json";
  jsonResponseFormat: boolean;
}

export function readLlmConfig(env: Record<string, string | undefined> = process.env): LlmConfig {
  const parsed = llmEnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Invalid LLM configuration: ${problems}`);
  }
  const value = parsed.data;
  return {
    apiKey: value.FIREWORKS_API_KEY,
    model: value.FIREWORKS_MODEL,
    baseURL: value.FIREWORKS_BASE_URL,
    mode: value.LLM_TOOL_CALL_MODE,
    jsonResponseFormat: value.LLM_JSON_RESPONSE_FORMAT,
  };
}
