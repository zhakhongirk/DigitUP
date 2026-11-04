import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomerAgent } from "@/server/agents/customer";
import { createPlatformMcpServer } from "@/server/mcp/platform/server";
import { createStoreDirectory, type StoreDirectory } from "@/server/mcp/platform/stores";
import { handlePlatformMcp } from "@/server/mcp/endpoints";
import { loadAgentChats } from "@/server/owner/inbox";
import type { BusinessModelInput } from "@/shared/business-model";
import { createTestTenant, testDb } from "../helpers/db";
import { ScriptedLlm } from "../helpers/llm";
import { connect, mcpRequest, testServices } from "../helpers/mcp";

const services = testServices();

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function modelOf(title: string, name: string): BusinessModelInput {
  return {
    profile: { name, description: `${name} sells things`, contacts: { address: "Almaty" } },
    offer_types: [{ key: "goods", name: "Goods", kind: "product", attributes: [] }],
    offers: [
      {
        title,
        offer_type: "goods",
        price: 100,
        currency: "KZT",
        price_status: "confirmed",
        availability: "in_stock",
      },
    ],
  };
}

async function store(title: string, name: string, live = true) {
  const ctx = await createTestTenant({ live, name });
  await services.catalog.applyBusinessModel({ ...ctx, actor: "system" }, modelOf(title, name));
  return ctx;
}

async function shop(name: string, titles: string[], description = `${name} sells things`) {
  const ctx = await createTestTenant({ live: true, name });
  const model = modelOf(titles[0]!, name);
  await services.catalog.applyBusinessModel(
    { ...ctx, actor: "system" },
    {
      ...model,
      profile: { ...model.profile, description },
      offers: titles.map((title, i) => ({
        ...model.offers![0]!,
        title,
        category: title.split(" ")[1],
        price: 100 * (i + 1),
      })),
    },
  );
  return ctx;
}

/** The real directory narrowed to the stores of one test, so other tests' stores do not interfere. */
function directory(...slugs: string[]): StoreDirectory {
  return createStoreDirectory(testDb(), { slugs });
}

function platform(stores: StoreDirectory, llm = new ScriptedLlm([])) {
  return connect(
    createPlatformMcpServer({
      stores,
      agent: createCustomerAgent({ services, llm }),
      services,
      baseUrl: "https://shop.example.com",
      ip: "203.0.113.5",
    }),
  );
}

const SESSION = "platform-session-001";

describe("platform MCP endpoint", () => {
  it("lists the platform tools", async () => {
    const a = await store("Zorbo Runner", "Zorbo Shop");
    const mcp = await platform(directory(a.slug));
    expect(await mcp.toolNames()).toEqual([
      "check_availability",
      "compare_offers",
      "find_offers",
      "find_stores",
      "get_offer_details",
      "list_stores",
      "report_answer",
      "talk_to_store",
    ]);
  });

  it("lists live stores only, filtered by city", async () => {
    const live = await store("Zorbo Runner", "Zorbo Shop");
    const draft = await store("Zorbo Runner", "Zorbo Draft", false);
    const mcp = await platform(directory(live.slug, draft.slug));

    const all = await mcp.call("list_stores");
    const data = all.data as {
      stores: { slug: string; name: string; city: string; url: string }[];
    };
    expect(data.stores.map((s) => s.slug)).toEqual([live.slug]);
    expect(data.stores[0]).toMatchObject({
      name: "Zorbo Shop",
      city: "Almaty",
      url: `https://shop.example.com/s/${live.slug}`,
    });

    const none = await mcp.call("list_stores", { city: "Astana" });
    expect((none.data as { stores: unknown[] }).stores).toEqual([]);
  });

  it("finds offers across stores, tags them and logs into each matching store", async () => {
    const a = await store("Zorbo Runner", "Zorbo North");
    const b = await store("Zorbo Runner", "Zorbo South");
    const other = await store("Quillon Sofa", "Quillon Furniture");
    const mcp = await platform(directory(a.slug, b.slug, other.slug));

    const result = await mcp.call("find_offers", { intent: "Zorbo Runner", session_id: SESSION });
    expect(result.isError).toBe(false);
    const data = result.data as {
      offers: { title: string; store: { slug: string } }[];
      stores: { slug: string; intent_id: string }[];
    };
    expect(data.offers.map((o) => o.store.slug).sort()).toEqual([a.slug, b.slug].sort());
    expect(data.stores.every((s) => s.intent_id.length > 0)).toBe(true);

    for (const ctx of [a, b]) {
      const view = await loadAgentChats(services, ctx);
      expect(view.chats).toHaveLength(1);
      expect(view.chats[0]!.firstLine).toContain("Zorbo Runner");
    }
    expect((await loadAgentChats(services, other)).chats).toHaveLength(0);
  });

  it("searches one store when store is given and scopes report_answer to it", async () => {
    const a = await store("Zorbo Runner", "Zorbo North");
    const b = await store("Zorbo Runner", "Zorbo South");
    const mcp = await platform(directory(a.slug, b.slug));

    const result = await mcp.call("find_offers", {
      intent: "Zorbo Runner",
      store: a.slug,
      session_id: SESSION,
    });
    const data = result.data as { intent_id: string; offers: { store: { slug: string } }[] };
    expect(data.offers.every((o) => o.store.slug === a.slug)).toBe(true);
    expect((await loadAgentChats(services, b)).chats).toHaveLength(0);

    const report = await mcp.call("report_answer", {
      store: a.slug,
      intent_id: data.intent_id,
      verdict: "wrong",
    });
    expect(report.isError).toBe(false);
    const foreign = await mcp.call("report_answer", {
      store: b.slug,
      intent_id: data.intent_id,
      verdict: "wrong",
    });
    expect(foreign.isError).toBe(true);
  });

  it("reads offer details of the named store only", async () => {
    const a = await store("Zorbo Runner", "Zorbo North");
    const b = await store("Zorbo Runner", "Zorbo South");
    const mcp = await platform(directory(a.slug, b.slug));
    const [offer] = (await services.catalog.searchOffers(a, {})).items;

    const own = await mcp.call("get_offer_details", { store: a.slug, offer_id: offer!.id });
    expect(own.isError).toBe(false);
    const foreign = await mcp.call("get_offer_details", { store: b.slug, offer_id: offer!.id });
    expect(foreign.isError).toBe(true);
  });

  it("talks to the assistant of the named store and keeps the chat in that tenant", async () => {
    const a = await store("Zorbo Runner", "Zorbo North");
    const b = await store("Zorbo Runner", "Zorbo South");
    const llm = new ScriptedLlm([{ reply: "Yes, we have it." }]);
    const mcp = await platform(directory(a.slug, b.slug), llm);

    const result = await mcp.call("talk_to_store", {
      store: a.slug,
      message: "Do you have a runner?",
      session_id: SESSION,
    });
    expect(result.data).toMatchObject({ reply: "Yes, we have it.", session_id: SESSION });

    const [conversation] = await services.conversations.list(a, {
      agent: "customer",
      channel: "external_agent",
      sessionKey: SESSION,
    });
    expect(conversation).toBeDefined();
    expect((await loadAgentChats(services, a)).chats).toHaveLength(1);
    expect((await loadAgentChats(services, b)).chats).toHaveLength(0);
  });

  it("answers unknown_store for unknown and not live slugs", async () => {
    const draft = await store("Zorbo Runner", "Zorbo Draft", false);
    const mcp = await platform(directory(draft.slug));
    for (const slug of ["no-such-store-xyz", draft.slug]) {
      const talk = await mcp.call("talk_to_store", {
        store: slug,
        message: "hi",
        session_id: SESSION,
      });
      expect(talk.isError).toBe(true);
      expect(talk.text).toContain("unknown_store");
      const find = await mcp.call("find_offers", { intent: "runner", store: slug });
      expect(find.isError).toBe(true);
      expect(find.text).toContain("unknown_store");
    }
  });

  it("serves tools/list over HTTP without credentials", async () => {
    const res = await handlePlatformMcp(
      mcpRequest("http://localhost/mcp/public", { jsonrpc: "2.0", id: 1, method: "tools/list" }),
      services,
      null,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name)).toContain("find_stores");
  });
});

describe("platform marketplace discovery", () => {
  type Entry = {
    slug: string;
    name: string;
    url: string;
    offer_count: number;
    matched_offers: number;
    top_categories: string[];
    price_range: { min: number; max: number; currency: string } | null;
    delivery: string | null;
  };
  const stores = (r: { data: unknown }) => (r.data as { stores: Entry[] }).stores;

  it("tells agents it is a marketplace of many stores", async () => {
    const a = await store("Zorbo Runner", "Zorbo Shop");
    const mcp = await platform(directory(a.slug));
    expect(mcp.client.getInstructions()).toMatch(
      /^This is a marketplace of independent local stores/,
    );
    const { tools } = await mcp.client.listTools();
    for (const t of tools) expect(t.description).toMatch(/[Mm]arketplace|Same as find_stores/);
    expect(tools.find((t) => t.name === "find_stores")!.description).toMatch(/^Start here/);
    expect(tools.find((t) => t.name === "find_offers")!.description).toMatch(/^Start here/);
  });

  it("finds a store by a product word that is not in its name, in Russian and English", async () => {
    const a = await shop("Alpha Outlet", ["Nimbus Sneakers black", "Nimbus Sneakers white"]);
    const b = await shop("Beta Studio", ["Quillon Sofa", "Quillon Table"]);
    const mcp = await platform(directory(a.slug, b.slug));

    for (const query of ["кроссовки", "sneakers", "кросовки"]) {
      const found = stores(await mcp.call("find_stores", { query }));
      expect(found.map((s) => s.slug)).toEqual([a.slug]);
    }
    expect(
      stores(await mcp.call("find_stores", { query: "диван sofa" })).map((s) => s.slug),
    ).toContain(b.slug);
    expect(stores(await mcp.call("find_stores", { query: "ракета" }))).toEqual([]);
  });

  it("returns compact store entries with catalog facts and match counts", async () => {
    const a = await shop("Alpha Outlet", [
      "Nimbus Sneakers black",
      "Nimbus Sneakers white",
      "Quillon Sofa",
    ]);
    const mcp = await platform(directory(a.slug));

    const [entry] = stores(await mcp.call("find_stores", { query: "sneakers" }));
    expect(entry).toMatchObject({
      slug: a.slug,
      name: "Alpha Outlet",
      url: `https://shop.example.com/s/${a.slug}`,
      offer_count: 3,
      matched_offers: 2,
      price_range: { min: 100, max: 300, currency: "KZT" },
    });
    expect(entry!.top_categories.length).toBeGreaterThan(0);
    expect(entry).toHaveProperty("delivery");
  });

  it("ranks stores by catalog relevance, then size, and keeps list_stores as an alias", async () => {
    const few = await shop("Aaa Few", [
      "Nimbus Sneakers",
      "Quillon Sofa",
      "Quillon Table",
      "Quillon Lamp",
    ]);
    const many = await shop("Zzz Many", [
      "Nimbus Sneakers red",
      "Nimbus Sneakers green",
      "Nimbus Sneakers blue",
    ]);
    const mcp = await platform(directory(few.slug, many.slug));

    const ranked = stores(await mcp.call("find_stores", { query: "sneakers" }));
    expect(ranked.map((s) => [s.slug, s.matched_offers])).toEqual([
      [many.slug, 3],
      [few.slug, 1],
    ]);

    const all = stores(await mcp.call("find_stores", { limit: 1 }));
    expect(all.map((s) => s.slug)).toEqual([few.slug]);

    const alias = stores(await mcp.call("list_stores", { query: "sneakers" }));
    expect(alias.map((s) => s.slug)).toEqual(ranked.map((s) => s.slug));
  });

  it("searches the stores that match the intent, not the oldest ones", async () => {
    const irrelevant = [];
    for (let i = 0; i < 22; i++)
      irrelevant.push(await shop(`Old Sofa ${i}`, [`Quillon Sofa ${i}`]));
    const relevant = await shop("Newest Outlet", ["Nimbus Sneakers black"]);
    const mcp = await platform(directory(...irrelevant.map((c) => c.slug), relevant.slug));

    const result = await mcp.call("find_offers", { intent: "кроссовки", session_id: SESSION });
    const data = result.data as {
      offers: { store: { slug: string } }[];
      stores: { slug: string; name: string; hits: number }[];
    };
    expect(data.offers.map((o) => o.store.slug)).toEqual([relevant.slug]);
    expect(data.stores).toMatchObject([{ slug: relevant.slug, name: "Newest Outlet", hits: 1 }]);
  });
});
