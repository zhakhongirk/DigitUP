import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shoeStoreModel } from "@/db/seed-data/shoe-store";
import { createCustomerAgent } from "@/server/agents/customer";
import { LLM_ERROR_REPLY } from "@/server/agents/runtime";
import type { TokenBudget } from "@/server/llm";
import { createTestTenant } from "../helpers/db";
import { ScriptedLlm } from "../helpers/llm";
import { testServices } from "../helpers/mcp";

const services = testServices();
const never: TokenBudget = { exceeded: async () => false };

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function shoeStore() {
  const ctx = await createTestTenant({ live: true });
  await services.catalog.applyBusinessModel({ ...ctx, actor: "system" }, shoeStoreModel);
  return ctx;
}

describe("fallback to the rule-based assistant", () => {
  for (const kind of ["api_error", "timeout", "empty_response"] as const) {
    it(`answers the same message when the first model call fails with ${kind}`, async () => {
      const ctx = await shoeStore();
      const llm = new ScriptedLlm([{ fail: kind }]);
      const result = await createCustomerAgent({ services, llm, budget: never }).reply({
        ctx,
        channel: "storefront",
        sessionKey: `session-fallback-${kind}`,
        message: "hi",
      });
      expect(result.stoppedBy).toBe("answer");
      expect(result.reply).not.toBe(LLM_ERROR_REPLY);
      expect(result.reply).not.toBe("");
    });
  }

  it("searches the catalog through the tools after the fallback", async () => {
    const ctx = await shoeStore();
    const llm = new ScriptedLlm([{ fail: "timeout" }]);
    const result = await createCustomerAgent({ services, llm, budget: never }).reply({
      ctx,
      channel: "storefront",
      sessionKey: "session-fallback-search",
      message: "sneakers",
    });
    expect(result.toolCalls.length).toBeGreaterThan(0);
    expect(llm.requests).toHaveLength(1);
  });

  it("keeps the error reply when the model fails after tools ran", async () => {
    const ctx = await shoeStore();
    const llm = new ScriptedLlm([{ call: [{ name: "get_business_info" }] }, { fail: "api_error" }]);
    const result = await createCustomerAgent({ services, llm, budget: never }).reply({
      ctx,
      channel: "storefront",
      sessionKey: "session-fallback-mid",
      message: "hello",
    });
    expect(result).toMatchObject({ reply: LLM_ERROR_REPLY, stoppedBy: "llm_error" });
  });

  it("skips the model for a store over its budget", async () => {
    const ctx = await shoeStore();
    const llm = new ScriptedLlm([{ reply: "from the model" }]);
    const budget: TokenBudget = { exceeded: async () => true };
    const result = await createCustomerAgent({ services, llm, budget }).reply({
      ctx,
      channel: "external_agent",
      sessionKey: "session-over-budget",
      message: "hi",
    });
    expect(llm.requests).toHaveLength(0);
    expect(result.reply).not.toBe("from the model");
    expect(result.stoppedBy).toBe("answer");
  });
});
