import { getDb } from "@/db/client";
import { readLlmConfig } from "./config";
import { createLlmRouter, type LlmRouter } from "./router";
import type { LlmClient, LlmTier } from "./types";
import { createTokenBudget, type TokenBudget } from "./budget";
import { createUsageRecorder } from "./usage";

export * from "./types";
export { createLlmClient, createOpenAiCompatibleClient } from "./client";
export {
  isLlmConfigured,
  readLlmConfig,
  readLlmModel,
  readTierConfig,
  type LlmConfig,
} from "./config";
export { withFallback } from "./fallback";
export { createTokenBudget, type TokenBudget } from "./budget";
export { createLlmRouter, tierForSurface, SURFACE_TIER, type LlmRouter } from "./router";

let router: LlmRouter | undefined;
let budget: TokenBudget | undefined;

/** Process-wide daily token budget of shopper-facing model calls. */
export function getTokenBudget(): TokenBudget {
  budget ??= createTokenBudget({ db: getDb });
  return budget;
}

/** Process-wide router configured from the environment. */
export function getLlmRouter(): LlmRouter {
  router ??= createLlmRouter({ recordUsage: createUsageRecorder(getDb) });
  return router;
}

/** Process-wide LLM client of a tier, configured from the environment. */
export function getLlmClient(tier: LlmTier = "main"): LlmClient {
  const client = getOptionalLlmClient(tier);
  if (!client) {
    readLlmConfig();
    throw new Error("No LLM is configured");
  }
  return client;
}

/** Like getLlmClient, but returns null when no model is configured. */
export function getOptionalLlmClient(tier: LlmTier = "main"): LlmClient | null {
  return getLlmRouter().forTier(tier);
}
