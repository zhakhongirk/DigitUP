import { describe, expect, it, vi } from "vitest";
import { isLlmConfigured, readTierConfig } from "@/server/llm/config";
import { createLlmRouter, tierForSurface } from "@/server/llm/router";
import type { OpenAiCompatibleClientOptions } from "@/server/llm/client";
import type { LlmClient } from "@/server/llm/types";

const MAIN = {
  LLM_API_KEY: "main-key",
  LLM_MODEL: "muse-spark-1.3",
  LLM_BASE_URL: "https://main.test/v1",
};

describe("readTierConfig", () => {
  it("returns the main settings for the main tier", () => {
    expect(readTierConfig("main", MAIN)).toMatchObject({
      apiKey: "main-key",
      model: "muse-spark-1.3",
      baseURL: "https://main.test/v1",
    });
  });

  it("falls back to the main settings for unset tier values", () => {
    const env = { ...MAIN, LLM_REASONING_EFFORT: "low", LLM_REASONING_TOKENS: "500" };
    expect(readTierConfig("fast", env)).toEqual(readTierConfig("main", env));
    expect(readTierConfig("heavy", env)).toEqual({
      ...readTierConfig("main", env),
      timeoutMs: 90_000,
    });
  });

  it("overrides only the values the tier sets and keeps the main key", () => {
    const config = readTierConfig("heavy", {
      ...MAIN,
      LLM_HEAVY_MODEL: "muse-wonder-1.0",
      LLM_HEAVY_REASONING_EFFORT: "high",
      LLM_HEAVY_REASONING_TOKENS: "2000",
    });
    expect(config).toMatchObject({
      apiKey: "main-key",
      baseURL: "https://main.test/v1",
      model: "muse-wonder-1.0",
      reasoningEffort: "high",
      reasoningTokens: 2000,
    });
  });

  it("uses a separate host with its own key and tool mode", () => {
    const config = readTierConfig("fast", {
      ...MAIN,
      LLM_FAST_API_KEY: "nv-key",
      LLM_FAST_BASE_URL: "https://integrate.api.nvidia.com/v1",
      LLM_FAST_MODEL: "meta/muse-glimmer-30b",
      LLM_FAST_TOOL_CALL_MODE: "json",
    });
    expect(config).toMatchObject({
      apiKey: "nv-key",
      baseURL: "https://integrate.api.nvidia.com/v1",
      model: "meta/muse-glimmer-30b",
      mode: "json",
    });
  });

  it("never sends the main key to a tier host that has no key", () => {
    expect(
      readTierConfig("fast", { ...MAIN, LLM_FAST_BASE_URL: "https://integrate.api.nvidia.com/v1" }),
    ).toBeNull();
  });

  it("can run on its own without a main model", () => {
    expect(
      readTierConfig("fast", {
        LLM_FAST_API_KEY: "k",
        LLM_FAST_BASE_URL: "https://x.test/v1",
        LLM_FAST_MODEL: "m",
      }),
    ).toMatchObject({ model: "m" });
    expect(readTierConfig("heavy", {})).toBeNull();
  });

  it("rejects invalid tier values", () => {
    expect(() => readTierConfig("fast", { ...MAIN, LLM_FAST_REASONING_EFFORT: "loud" })).toThrow(
      /fast/,
    );
  });
});

describe("router", () => {
  function setup(env: Record<string, string>) {
    const built: OpenAiCompatibleClientOptions[] = [];
    const router = createLlmRouter({
      env,
      build: (options) => {
        built.push(options);
        return { mode: options.mode, model: options.model, chat: vi.fn() } satisfies LlmClient;
      },
    });
    return { router, built };
  }

  it("maps each surface to its tier", () => {
    expect(tierForSurface("storefront_chat")).toBe("main");
    expect(tierForSurface("public_mcp")).toBe("main");
    expect(tierForSurface("owner_agent")).toBe("main");
    expect(tierForSurface("intent_rewrite")).toBe("fast");
    expect(tierForSurface("onboarding")).toBe("heavy");
  });

  it("builds a client per tier with its own model and caches it", () => {
    const { router, built } = setup({
      ...MAIN,
      LLM_FAST_MODEL: "meta/muse-glimmer-30b",
      LLM_HEAVY_MODEL: "muse-wonder-1.0",
    });
    expect(router.forSurface("storefront_chat")?.model).toBe("muse-spark-1.3");
    expect(router.forSurface("intent_rewrite")?.model).toBe("meta/muse-glimmer-30b");
    expect(router.forSurface("onboarding")?.model).toBe("muse-wonder-1.0");
    router.forSurface("intent_rewrite");
    router.forTier("main");
    expect(built.map((b) => b.tier)).toEqual(["main", "fast", "heavy"]);
  });

  it("uses the main client for a tier without settings of its own", () => {
    const { router } = setup(MAIN);
    expect(router.forTier("fast")?.model).toBe("muse-spark-1.3");
    expect(router.forTier("heavy")?.model).toBe("muse-spark-1.3");
  });

  it("returns null everywhere when no model is configured", () => {
    const { router } = setup({});
    expect(isLlmConfigured({})).toBe(false);
    expect(router.forTier("main")).toBeNull();
    expect(router.forTier("fast")).toBeNull();
    expect(router.forSurface("onboarding")).toBeNull();
  });
});
