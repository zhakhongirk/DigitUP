import { getDb } from "@/db/client";
import { createFireworksClient } from "./client";
import { isLlmConfigured, readLlmConfig } from "./config";
import type { LlmClient } from "./types";
import { createUsageRecorder } from "./usage";

export * from "./types";
export { createLlmClient, createFireworksClient } from "./client";
export { isLlmConfigured, readLlmConfig, readLlmModel, type LlmConfig } from "./config";

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
  if (!isLlmConfigured()) return null;
  return getLlmClient();
}
