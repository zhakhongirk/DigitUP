import { createFireworksClient } from "./client";
import { readLlmConfig } from "./config";
import type { LlmClient } from "./types";

export * from "./types";
export { createLlmClient, createFireworksClient } from "./client";
export { readLlmConfig, type LlmConfig } from "./config";

let shared: LlmClient | undefined;

/** Process-wide LLM client configured from the environment. */
export function getLlmClient(): LlmClient {
  shared ??= createFireworksClient(readLlmConfig());
  return shared;
}
