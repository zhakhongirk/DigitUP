import { describe, expect, it } from "vitest";
import { FIREWORKS_BASE_URL, readLlmConfig } from "@/server/llm/config";

describe("readLlmConfig", () => {
  it("applies defaults", () => {
    const config = readLlmConfig({ FIREWORKS_API_KEY: "k", FIREWORKS_MODEL: "m" });
    expect(config).toEqual({
      apiKey: "k",
      model: "m",
      baseURL: FIREWORKS_BASE_URL,
      mode: "native",
      jsonResponseFormat: true,
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
    expect(() => readLlmConfig({})).toThrow(/FIREWORKS_API_KEY is required/);
  });

  it("rejects an unknown tool call mode", () => {
    expect(() =>
      readLlmConfig({ FIREWORKS_API_KEY: "k", FIREWORKS_MODEL: "m", LLM_TOOL_CALL_MODE: "xml" }),
    ).toThrow(/Invalid LLM configuration/);
  });
});
