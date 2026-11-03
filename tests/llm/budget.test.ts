import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { llmUsage } from "@/db/schema";
import { createTokenBudget, readDailyTokenBudget } from "@/server/llm/budget";
import { createTestTenant, testDb } from "../helpers/db";

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function spend(tenantId: string, tokens: number, surface = "storefront_chat") {
  await testDb()
    .insert(llmUsage)
    .values({ tenantId, surface, model: "m", inputTokens: tokens - 10, outputTokens: 10 });
}

const LIMIT = { LLM_DAILY_TOKEN_BUDGET: "500" };

describe("daily token budget", () => {
  it("reads the limit with a default and zero as unlimited", () => {
    expect(readDailyTokenBudget({})).toBe(300_000);
    expect(readDailyTokenBudget({ LLM_DAILY_TOKEN_BUDGET: "1000" })).toBe(1000);
    expect(readDailyTokenBudget({ LLM_DAILY_TOKEN_BUDGET: "0" })).toBe(0);
    expect(readDailyTokenBudget({ LLM_DAILY_TOKEN_BUDGET: "lots" })).toBe(300_000);
  });

  it("is exceeded once today's shopper usage reaches the limit", async () => {
    const { tenantId } = await createTestTenant();
    expect(await createTokenBudget({ db: testDb, env: LIMIT }).exceeded(tenantId)).toBe(false);
    await spend(tenantId, 600);
    expect(await createTokenBudget({ db: testDb, env: LIMIT }).exceeded(tenantId)).toBe(true);
  });

  it("ignores owner usage, other stores and zero meaning unlimited", async () => {
    const a = await createTestTenant();
    const b = await createTestTenant();
    await spend(a.tenantId, 900, "owner_agent");
    await spend(b.tenantId, 900);
    expect(await createTokenBudget({ db: testDb, env: LIMIT }).exceeded(a.tenantId)).toBe(false);
    const unlimited = createTokenBudget({ db: testDb, env: { LLM_DAILY_TOKEN_BUDGET: "0" } });
    expect(await unlimited.exceeded(b.tenantId)).toBe(false);
  });

  it("does not count usage from before the current UTC day", async () => {
    const { tenantId } = await createTestTenant();
    await spend(tenantId, 900);
    const budget = createTokenBudget({
      db: testDb,
      env: LIMIT,
      now: () => new Date(Date.now() + 36 * 3600_000),
    });
    expect(await budget.exceeded(tenantId)).toBe(false);
  });

  it("caches the sum for a short time", async () => {
    const { tenantId } = await createTestTenant();
    let now = Date.now();
    const budget = createTokenBudget({ db: testDb, env: LIMIT, now: () => new Date(now) });
    expect(await budget.exceeded(tenantId)).toBe(false);
    await spend(tenantId, 900);
    expect(await budget.exceeded(tenantId)).toBe(false);
    now += 31_000;
    expect(await budget.exceeded(tenantId)).toBe(true);
  });

  it("fails open when the query errors", async () => {
    const budget = createTokenBudget({
      db: () => {
        throw new Error("down");
      },
      env: { LLM_DAILY_TOKEN_BUDGET: "1" },
    });
    expect(await budget.exceeded("00000000-0000-0000-0000-000000000000")).toBe(false);
  });
});
