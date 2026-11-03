import { describe, expect, it } from "vitest";
import { DEFAULT_LLM_BASE_URL, isLlmConfigured, readLlmConfig } from "@/server/llm/config";

describe("readLlmConfig", () => {
  it("applies defaults", () => {
    const config = readLlmConfig({ FIREWORKS_API_KEY: "k", FIREWORKS_MODEL: "m" });
    expect(config).toEqual({
      apiKey: "k",
      model: "m",
      baseURL: DEFAULT_LLM_BASE_URL,
      mode: "native",
      jsonResponseFormat: true,
      reasoningTokens: 0,
    });
  });

  it("reads the JSON fallback settings", () => {
    const config = readLlmConfig({
      FIREWORKS_API_KEY: "k",
      FIREWORKS_MODEL: "m",
      LLM_TOOL_CALL_MODE: "json",
      LLM_JSON_RESPONSE_FORMAT: "false",
    });
    expect(config.mode).toBe("json");
    expect(config.jsonResponseFormat).toBe(false);
  });

  it("fails clearly when required values are missing", () => {
    expect(() => readLlmConfig({})).toThrow(/LLM_API_KEY is required/);
  });

  it("rejects an unknown tool call mode", () => {
    expect(() =>
      readLlmConfig({ FIREWORKS_API_KEY: "k", FIREWORKS_MODEL: "m", LLM_TOOL_CALL_MODE: "xml" }),
    ).toThrow(/Invalid LLM configuration/);
  });

  it("prefers LLM_* over the legacy FIREWORKS_* names", () => {
    const config = readLlmConfig({
      LLM_API_KEY: "new",
      LLM_MODEL: "muse-spark-1.3",
      LLM_BASE_URL: "https://api.meta.ai/v1",
      FIREWORKS_API_KEY: "old",
      FIREWORKS_MODEL: "old-model",
      FIREWORKS_BASE_URL: "https://old.example/v1",
    });
    expect(config).toMatchObject({
      apiKey: "new",
      model: "muse-spark-1.3",
      baseURL: "https://api.meta.ai/v1",
    });
  });

  it("falls back to the legacy names when LLM_* is empty", () => {
    const env = {
      LLM_API_KEY: "",
      FIREWORKS_API_KEY: "old",
      FIREWORKS_MODEL: "old-model",
      FIREWORKS_BASE_URL: "https://old.example/v1",
    };
    expect(readLlmConfig(env)).toMatchObject({
      apiKey: "old",
      model: "old-model",
      baseURL: "https://old.example/v1",
    });
    expect(isLlmConfigured(env)).toBe(true);
    expect(isLlmConfigured({ LLM_API_KEY: "k" })).toBe(false);
  });

  it("reads reasoning settings", () => {
    const config = readLlmConfig({
      LLM_API_KEY: "k",
      LLM_MODEL: "m",
      LLM_REASONING_EFFORT: "minimal",
      LLM_REASONING_TOKENS: "1024",
    });
    expect(config.reasoningEffort).toBe("minimal");
    expect(config.reasoningTokens).toBe(1024);
  });

  it("rejects reasoning effort none and negative headroom", () => {
    const base = { LLM_API_KEY: "k", LLM_MODEL: "m" };
    expect(() => readLlmConfig({ ...base, LLM_REASONING_EFFORT: "none" })).toThrow(
      /Invalid LLM configuration/,
    );
    expect(() => readLlmConfig({ ...base, LLM_REASONING_TOKENS: "-1" })).toThrow(
      /Invalid LLM configuration/,
    );
  });
});
