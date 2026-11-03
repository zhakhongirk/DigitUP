import { getDb } from "@/db/client";
import { createFireworksClient } from "./client";
import { readLlmConfig } from "./config";
import type { LlmClient } from "./types";
import { createUsageRecorder } from "./usage";

export * from "./types";
export { createLlmClient, createFireworksClient } from "./client";
export { readLlmConfig, type LlmConfig } from "./config";

let shared: LlmClient | undefined;

/** Process-wide LLM client configured from the environment. */
export function getLlmClient(): LlmClient {
  shared ??= createFireworksClient({
    ...readLlmConfig(),
    recordUsage: createUsageRecorder(getDb),
  });
  return shared;
}

/** Like getLlmClient, but returns null when no model is configured. */
export function getOptionalLlmClient(): LlmClient | null {
  if (!process.env.FIREWORKS_API_KEY || !process.env.FIREWORKS_MODEL) return null;
  return getLlmClient();
}
