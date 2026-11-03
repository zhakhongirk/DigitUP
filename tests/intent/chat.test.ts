import { describe, expect, it } from "vitest";
import { shoeStoreModel } from "@/db/seed-data/shoe-store";
import { createCustomerAgent } from "@/server/agents/customer";
import { handleChatMessage, newChatSession } from "@/server/storefront/chat";
import { createTestTenant } from "../helpers/db";
import { testServices } from "../helpers/mcp";

const services = testServices();

async function store() {
  const ctx = await createTestTenant({ live: true });
  await services.catalog.applyBusinessModel({ ...ctx, actor: "system" }, shoeStoreModel);
  return ctx;
}

type Event = { type: string; name?: string; content?: string; arguments?: unknown };

async function chat(slug: string, message: string) {
  const response = await handleChatMessage(
    new Request("http://localhost/api/s/x/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    }),
    slug,
    services,
    null,
  );
  const lines = (await response.text()).split("\n").filter(Boolean);
  return lines.map((line) => JSON.parse(line) as Event);
}

const replyOf = (events: Event[]) => events.find((e) => e.type === "message")?.content ?? "";

describe("storefront chat uses the intent layer", () => {
  it("searches with find_offers, not with raw search", async () => {
    const ctx = await store();
    const events = await chat(ctx.slug, "кроссовки");
    const calls = events.filter((e) => e.type === "tool_call").map((e) => e.name);
    expect(calls).toEqual(["find_offers"]);
  });

  it("understands typos, color and size in one sentence", async () => {
    const ctx = await store();
    const text = replyOf(await chat(ctx.slug, "чорные кросовки 43 до 75 000"));
    expect(text).toContain("Nordix Hightop Classic");
    expect(text).not.toContain("Velor");
  });

  it("converts a US size for the shopper", async () => {
    const ctx = await store();
    const text = replyOf(await chat(ctx.slug, "black sneakers size 10 US under 75k"));
    expect(text).toContain("Nordix Hightop Classic");
    expect(text).toContain("size 10 is listed");
  });

  it("tells the shopper which filter was loosened", async () => {
    const ctx = await store();
    const text = replyOf(await chat(ctx.slug, "black boots size 42"));
    expect(text).toContain("There was no exact match, so I loosened: size.");
    expect(text).toContain("Altai Women's Winter Boots");
  });

  it("shows offers with price on request apart from priced ones", async () => {
    const ctx = await store();
    const text = replyOf(await chat(ctx.slug, "sneakers under 5000"));
    expect(text).toContain("No offer with a confirmed price is within 5 000.");
    expect(text).toContain("Kazbek Limited Edition Sneakers");
  });

  it("logs the chat search as an intent of the storefront channel", async () => {
    const ctx = await store();
    await chat(ctx.slug, "boots");
    const stats = await services.intent.stats({ tenantId: ctx.tenantId, actor: "owner" });
    expect(stats.findOffers).toBe(1);
  });
});

describe("talk_to_store uses the intent layer", () => {
  it("answers a product question through find_offers", async () => {
    const ctx = await store();
    const agent = createCustomerAgent({ services, llm: null });
    const events: Event[] = [];
    const result = await agent.reply({
      ctx: { tenantId: ctx.tenantId, actor: "customer_agent" },
      channel: "external_agent",
      sessionKey: newChatSession(),
      message: "krossovki 43",
      onEvent: (e) => events.push(e as Event),
    });
    expect(events.filter((e) => e.type === "tool_call").map((e) => e.name)).toEqual([
      "find_offers",
    ]);
    expect(result.reply).toContain("Nordix");
  });
});
