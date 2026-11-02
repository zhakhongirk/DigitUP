import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shoeStoreModel } from "@/db/seed-data/shoe-store";
import { onboardingMaterial } from "@/server/agents/business/prompt";
import { runProposal } from "@/server/agents/business/onboarding";
import { createServices } from "@/server/container";
import { createTestTenant, recordingEvents, TEST_AUTH_SECRET, testDb } from "../helpers/db";
import { ScriptedLlm } from "../helpers/llm";
import { tempStorage } from "../helpers/storage";

const storage = await tempStorage();
const services = createServices({
  db: testDb(),
  events: recordingEvents(),
  authSecret: TEST_AUTH_SECRET,
  storage,
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const csv = "Name,Price,Stock\nTea,4 000 ₸,5\nCoffee,3 000 ₸,0";

async function pendingRun() {
  const ctx = await createTestTenant({ name: "Tea House" });
  const { assets, run } = await services.ingestion.addSources(ctx, {
    note: "Tea House sells tea. Call +7 701 123 45 67.",
    files: [{ filename: "menu.csv", bytes: new TextEncoder().encode(csv) }],
  });
  for (const asset of assets) await services.ingestion.extractAsset(ctx.tenantId, asset.id);
  return { ctx, run };
}

const propose = {
  call: [{ name: "propose_business_model", arguments: { model: shoeStoreModel } }],
};

describe("runProposal", () => {
  it("builds a draft with the importer when there is no model", async () => {
    const { ctx, run } = await pendingRun();
    const outcome = await runProposal(
      { services, llm: null },
      { tenantId: ctx.tenantId, runId: run.id },
    );

    expect(outcome).toMatchObject({ status: "succeeded", by: "import" });
    const draft = await services.catalog.getLatestDraft(ctx);
    expect(outcome.status === "succeeded" && outcome.draftId).toBe(draft?.id);
    expect((draft?.payload as { offers: unknown[] }).offers).toHaveLength(2);
    expect(await services.ingestion.getLatestRun(ctx)).toMatchObject({
      status: "succeeded",
      draftId: draft?.id,
    });
  });

  it("uses the draft the agent proposes", async () => {
    const { ctx, run } = await pendingRun();
    const llm = new ScriptedLlm([propose, { reply: "Draft saved." }]);
    const outcome = await runProposal({ services, llm }, { tenantId: ctx.tenantId, runId: run.id });

    expect(outcome).toMatchObject({ status: "succeeded", by: "agent" });
    const draft = await services.catalog.getLatestDraft(ctx);
    expect(draft?.status).toBe("draft");
    expect((draft?.payload as { profile: { name: string } }).profile.name).toBe(
      shoeStoreModel.profile.name,
    );
    expect(llm.requests[0]?.messages.some((m) => String(m.content).includes("menu.csv"))).toBe(
      true,
    );
  });

  it("falls back to the importer when the agent saves nothing", async () => {
    const { ctx, run } = await pendingRun();
    const llm = new ScriptedLlm([{ reply: "I could not find anything." }]);
    const outcome = await runProposal({ services, llm }, { tenantId: ctx.tenantId, runId: run.id });
    expect(outcome).toMatchObject({ status: "succeeded", by: "import" });
  });

  it("falls back to the importer when the model fails", async () => {
    const { ctx, run } = await pendingRun();
    const llm = new ScriptedLlm([{ fail: "api_error" }]);
    const log = vi.fn();
    const outcome = await runProposal(
      { services, llm, log },
      { tenantId: ctx.tenantId, runId: run.id },
    );
    expect(outcome).toMatchObject({ status: "succeeded", by: "import" });
    expect(log).toHaveBeenCalled();
  });

  it("skips a run that was already taken", async () => {
    const { ctx, run } = await pendingRun();
    const input = { tenantId: ctx.tenantId, runId: run.id };
    await runProposal({ services, llm: null }, input);
    expect(await runProposal({ services, llm: null }, input)).toEqual({ status: "skipped" });
  });

  it("skips a run of another tenant", async () => {
    const { run } = await pendingRun();
    const other = await createTestTenant();
    const outcome = await runProposal(
      { services, llm: null },
      { tenantId: other.tenantId, runId: run.id },
    );
    expect(outcome).toEqual({ status: "skipped" });
  });
});

describe("onboardingMaterial", () => {
  it("keeps every source header and stays near the budget when truncating", () => {
    const sources = [
      { filename: "big.txt", text: "a".repeat(50_000) },
      { filename: "huge.txt", text: "b".repeat(80_000) },
      { filename: "small.txt", text: "c".repeat(300) },
    ];
    const material = onboardingMaterial(sources, 20_000);
    for (const s of sources) expect(material).toContain(`### ${s.filename}`);
    expect(material).toContain("[truncated]");
    expect(material).toContain("c".repeat(300));
    expect(material.length).toBeLessThan(20_000 + 500);
  });

  it("leaves short material untouched and drops empty sources", () => {
    const material = onboardingMaterial([
      { filename: "a.txt", text: " hello " },
      { filename: "empty.txt", text: "  " },
    ]);
    expect(material).toBe("### a.txt\nhello");
  });
});
