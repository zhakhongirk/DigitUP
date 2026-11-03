import { createFireworksClient } from "./client";
import { readTierConfig } from "./config";
import type { LlmClient, LlmSurface, LlmTier, LlmUsageRecord } from "./types";

export const SURFACE_TIER: Record<LlmSurface, LlmTier> = {
  storefront_chat: "main",
  public_mcp: "main",
  owner_agent: "main",
  intent_rewrite: "fast",
  onboarding: "heavy",
};

export function tierForSurface(surface: LlmSurface): LlmTier {
  return SURFACE_TIER[surface];
}

type Env = Record<string, string | undefined>;
type Build = typeof createFireworksClient;

export interface LlmRouter {
  /** The client of a tier; a tier without usable settings of its own uses the main one. */
  forTier(tier: LlmTier): LlmClient | null;
  forSurface(surface: LlmSurface): LlmClient | null;
}

export function createLlmRouter({
  env = process.env,
  recordUsage,
  build = createFireworksClient,
}: {
  env?: Env;
  recordUsage?: (record: LlmUsageRecord) => Promise<void> | void;
  build?: Build;
} = {}): LlmRouter {
  const clients = new Map<LlmTier, LlmClient | null>();

  function forTier(tier: LlmTier): LlmClient | null {
    const cached = clients.get(tier);
    if (cached !== undefined) return cached;
    const config = readTierConfig(tier, env);
    const client = config
      ? build({
          tier,
          apiKey: config.apiKey,
          model: config.model,
          baseURL: config.baseURL,
          mode: config.mode,
          jsonResponseFormat: config.jsonResponseFormat,
          reasoningEffort: config.reasoningEffort,
          reasoningTokens: config.reasoningTokens,
          recordUsage,
        })
      : tier === "main"
        ? null
        : forTier("main");
    clients.set(tier, client);
    return client;
  }

  return { forTier, forSurface: (surface) => forTier(tierForSurface(surface)) };
}
