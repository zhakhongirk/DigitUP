import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditEvents, intentEvents } from "@/db/schema";
import { shoeStoreModel } from "@/db/seed-data/shoe-store";
import { loadAnalytics } from "@/server/owner/analytics";
import { handlePublicMcp } from "@/server/mcp/endpoints";
import { createCustomerMcpServer } from "@/server/mcp/customer/server";
import type { TenantContext } from "@/server/services/context";
import { createTestTenant, testDb } from "../helpers/db";
import { connect, mcpRequest, testServices } from "../helpers/mcp";

const services = testServices();
const db = testDb();

interface Row {
  offer_id: string;
  title: string;
  price: number | null;
  currency: string | null;
  price_status: string;
  availability: string;
  can_order: boolean;
  sizes: string[];
  unavailable_sizes?: string[];
  matched: { size: boolean | null; color: boolean | null; budget: boolean | null };
  url: string | null;
}
interface FindResult {
  intent_id: string;
  summary: string;
  offers: Row[];
  applied: Record<string, unknown>;
  relaxed: { step: string; from: string; to: string | null }[];
  on_request: Row[];
  unresolved: string[];
  raw_hint: { tool: string; arguments: Record<string, unknown>; other_tools: string[] };
}

const open: Awaited<ReturnType<typeof connect>>[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
  delete process.env.PUBLIC_RAW_TOOLS;
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

async function newStore() {
  const ctx = await createTestTenant({ actor: "customer_agent", live: true });
  await services.catalog.applyBusinessModel({ ...ctx, actor: "system" }, shoeStoreModel);
  return ctx;
}

async function customerClient(ctx: TenantContext, extra: { trackRaw?: boolean } = {}) {
  const client = await connect(
    createCustomerMcpServer({
      ctx,
      services,
      source: "external_agent",
      tracking: { channel: "external_agent", clientKey: `key:${randomUUID()}` },
      store: { slug: "stride", baseUrl: "https://shop.example" },
      ...extra,
    }),
  );
  open.push(client);
  return client;
}

describe("find_offers on the keyed customer endpoint", () => {
  it("returns the documented shape", async () => {
    const mcp = await customerClient(await newStore());
    const res = await mcp.call("find_offers", { intent: "чёрные кроссовки 43 до 75 000" });
    expect(res.isError).toBe(false);
    const data = res.data as FindResult;
    expect(data.intent_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.summary).toContain("Найдено");
    expect(data.offers).toHaveLength(1);
    expect(data.offers[0]).toMatchObject({
      title: "Nordix Hightop Classic",
      price: 27500,
      currency: "KZT",
      price_status: "confirmed",
      availability: "out_of_stock",
      can_order: false,
      matched: { size: true, color: true, budget: true },
    });
    expect(data.offers[0]?.unavailable_sizes).toContain("43");
    expect(data.offers[0]?.url).toMatch(
      /^https:\/\/shop\.example\/s\/stride\/offers\/[0-9a-f-]{36}$/,
    );
    expect(data.applied).toMatchObject({
      category: "Sneakers",
      max_price: 75000,
      min_price: null,
      terms: [],
      size: { requested: "43", values: ["43"] },
    });
    expect(data.relaxed).toEqual([]);
    expect(data.on_request).toEqual([]);
    expect(data.unresolved).toEqual([]);
    expect(data.raw_hint.tool).toBe("search_offers");
    expect(data.raw_hint.other_tools).toEqual([
      "get_offer_details",
      "check_availability",
      "compare_offers",
    ]);
  });

  it("separates offers with price on request and records relaxed filters", async () => {
    const mcp = await customerClient(await newStore());
    const data = (await mcp.call("find_offers", { intent: "black sneakers size 46 under 45k" }))
      .data as FindResult;
    expect(data.relaxed.map((r) => r.step)).toContain("size");
    expect(data.on_request.every((o) => o.price_status === "on_request")).toBe(true);
    expect(data.on_request.every((o) => o.price === null && o.can_order === false)).toBe(true);
    expect(data.offers.every((o) => o.price_status === "confirmed")).toBe(true);
  });

  it("accepts a language hint and a session id", async () => {
    const mcp = await customerClient(await newStore());
    const ok = await mcp.call("find_offers", {
      intent: "krossovki",
      lang: "ru",
      session_id: "session-0001",
    });
    expect(ok.isError).toBe(false);
    expect((ok.data as FindResult).summary).toContain("Найдено");
    expect((await mcp.call("find_offers", { intent: "x", lang: "de" })).isError).toBe(true);
    expect((await mcp.call("find_offers", { intent: "" })).isError).toBe(true);
    expect((await mcp.call("find_offers", { intent: "boots", session_id: "bad id" })).isError).toBe(
      true,
    );
  });

  it("is listed next to the raw tools and report_answer", async () => {
    const mcp = await customerClient(await newStore());
    const names = await mcp.toolNames();
    expect(names).toEqual(
      expect.arrayContaining(["find_offers", "report_answer", "search_offers"]),
    );
  });

  it("logs every call with the filters that were applied", async () => {
    const ctx = await newStore();
    const mcp = await customerClient(ctx);
    const data = (await mcp.call("find_offers", { intent: "red sneakers" })).data as FindResult;
    const [event] = await db.select().from(intentEvents).where(eq(intentEvents.id, data.intent_id));
    expect(event).toMatchObject({
      tenantId: ctx.tenantId,
      kind: "find_offers",
      channel: "external_agent",
      text: "red sneakers",
      verdict: null,
      afterIntentId: null,
    });
    expect(event?.relaxed).toEqual(data.relaxed);
    expect(event?.resultIds).toEqual([...data.offers, ...data.on_request].map((o) => o.offer_id));
  });
});

describe("report_answer", () => {
  it("stores the verdict and writes an audit entry by the customer agent", async () => {
    const ctx = await newStore();
    const mcp = await customerClient(ctx);
    const found = (await mcp.call("find_offers", { intent: "sneakers" })).data as FindResult;
    const res = await mcp.call("report_answer", {
      intent_id: found.intent_id,
      verdict: "incomplete",
      comment: "Missing the white pair",
    });
    expect(res.isError).toBe(false);
    expect(res.data).toEqual({ ok: true, intent_id: found.intent_id, verdict: "incomplete" });

    const [event] = await db
      .select()
      .from(intentEvents)
      .where(eq(intentEvents.id, found.intent_id));
    expect(event).toMatchObject({ verdict: "incomplete", comment: "Missing the white pair" });

    const audit = await services.audit.list(ctx, { entity: "intent_event" });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: "customer_agent",
      action: "intent.reported",
      entityId: found.intent_id,
      after: { verdict: "incomplete", comment: "Missing the white pair" },
    });
  });

  it("lets the agent change its verdict", async () => {
    const ctx = await newStore();
    const mcp = await customerClient(ctx);
    const found = (await mcp.call("find_offers", { intent: "boots" })).data as FindResult;
    await mcp.call("report_answer", { intent_id: found.intent_id, verdict: "wrong" });
    await mcp.call("report_answer", { intent_id: found.intent_id, verdict: "ok" });
    const [event] = await db
      .select()
      .from(intentEvents)
      .where(eq(intentEvents.id, found.intent_id));
    expect(event?.verdict).toBe("ok");
    expect(await services.audit.list(ctx, { entity: "intent_event" })).toHaveLength(2);
  });

  it("rejects unknown verdicts, unknown ids and ids of other stores", async () => {
    const ctx = await newStore();
    const other = await newStore();
    const mcp = await customerClient(ctx);
    const found = (await mcp.call("find_offers", { intent: "sandals" })).data as FindResult;

    expect(
      (await mcp.call("report_answer", { intent_id: found.intent_id, verdict: "bad" })).isError,
    ).toBe(true);
    expect((await mcp.call("report_answer", { intent_id: "nope", verdict: "ok" })).isError).toBe(
      true,
    );
    const unknown = await mcp.call("report_answer", { intent_id: randomUUID(), verdict: "ok" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("not_found");

    const foreign = await customerClient(other);
    const stolen = await foreign.call("report_answer", {
      intent_id: found.intent_id,
      verdict: "wrong",
    });
    expect(stolen.isError).toBe(true);
    const [event] = await db
      .select()
      .from(intentEvents)
      .where(eq(intentEvents.id, found.intent_id));
    expect(event?.verdict).toBeNull();
  });

  it("rejects an over-long comment", async () => {
    const mcp = await customerClient(await newStore());
    const found = (await mcp.call("find_offers", { intent: "sandals" })).data as FindResult;
    const tooLong = await mcp.call("report_answer", {
      intent_id: found.intent_id,
      verdict: "wrong",
      comment: "x".repeat(501),
    });
    expect(tooLong.isError).toBe(true);
  });
});

describe("raw calls after find_offers", () => {
  it("marks a search_offers call from the same caller with the intent it follows", async () => {
    const ctx = await newStore();
    const mcp = await customerClient(ctx, { trackRaw: true });
    const found = (await mcp.call("find_offers", { intent: "sneakers" })).data as FindResult;
    await mcp.call("search_offers", { ...found.raw_hint.arguments, query: "Nordix" });

    const events = await db
      .select()
      .from(intentEvents)
      .where(eq(intentEvents.tenantId, ctx.tenantId));
    const raw = events.find((e) => e.kind === "search_offers");
    expect(raw).toMatchObject({ afterIntentId: found.intent_id, channel: "external_agent" });
    expect(raw?.applied).toMatchObject({ query: "Nordix" });
    expect((raw?.resultIds as string[]).length).toBeGreaterThan(0);

    expect(await services.intent.stats(ctx)).toMatchObject({ findOffers: 1, followedByRaw: 1 });
  });

  it("links by session id when the caller gives one", async () => {
    const ctx = await newStore();
    const track = { channel: "external_agent" as const, sessionKey: "session-link-1" };
    const found = await services.intent.resolveIntent(ctx, { text: "boots", track });
    const linked = await services.intent.recordRawCall(ctx, {
      tool: "get_offer_details",
      args: { offer_id: "x" },
      resultIds: [],
      track,
    });
    expect(linked).not.toBeNull();
    const [raw] = await db.select().from(intentEvents).where(eq(intentEvents.id, linked!));
    expect(raw?.afterIntentId).toBe(found.intentId);
  });

  it("ignores raw calls with no find_offers before them", async () => {
    const ctx = await newStore();
    const mcp = await customerClient(ctx, { trackRaw: true });
    await mcp.call("search_offers", { query: "boots" });
    const events = await db
      .select()
      .from(intentEvents)
      .where(eq(intentEvents.tenantId, ctx.tenantId));
    expect(events).toEqual([]);
  });

  it("does not link a different caller", async () => {
    const ctx = await newStore();
    const first = await customerClient(ctx, { trackRaw: true });
    await first.call("find_offers", { intent: "sneakers" });
    const second = await customerClient(ctx, { trackRaw: true });
    await second.call("search_offers", { query: "boots" });
    expect(await services.intent.stats(ctx)).toMatchObject({ findOffers: 1, followedByRaw: 0 });
  });

  it("does not track raw calls of the in-store assistant", async () => {
    const ctx = await newStore();
    const mcp = await customerClient(ctx);
    await mcp.call("find_offers", { intent: "sneakers" });
    await mcp.call("search_offers", { query: "boots" });
    expect(await services.intent.stats(ctx)).toMatchObject({ findOffers: 1, followedByRaw: 0 });
  });
});

describe("intent statistics", () => {
  it("counts answers, verdicts and the raw follow-up rate", async () => {
    const ctx = await newStore();
    const mcp = await customerClient(ctx, { trackRaw: true });
    const a = (await mcp.call("find_offers", { intent: "sneakers" })).data as FindResult;
    const b = (await mcp.call("find_offers", { intent: "boots" })).data as FindResult;
    await mcp.call("find_offers", { intent: "sandals" });
    await mcp.call("report_answer", { intent_id: a.intent_id, verdict: "wrong" });
    await mcp.call("report_answer", { intent_id: b.intent_id, verdict: "incomplete" });
    await mcp.call("search_offers", { query: "sandals" });
    expect(await services.intent.stats(ctx)).toEqual({
      findOffers: 3,
      reported: 2,
      wrong: 1,
      incomplete: 1,
      followedByRaw: 1,
    });
  });

  it("feeds the analytics card", async () => {
    const ctx = await newStore();
    const mcp = await customerClient(ctx, { trackRaw: true });
    const a = (await mcp.call("find_offers", { intent: "sneakers" })).data as FindResult;
    await mcp.call("find_offers", { intent: "boots" });
    await mcp.call("report_answer", { intent_id: a.intent_id, verdict: "wrong" });
    await mcp.call("search_offers", { query: "boots" });
    const view = await loadAnalytics(services, { ...ctx, actor: "owner" }, 30);
    expect(view.answers).toEqual({ findOffers: 2, rated: 1, flaggedShare: 1, rawShare: 0.5 });
  });

  it("looks only at the requested window and only at this store", async () => {
    const ctx = await newStore();
    const other = await newStore();
    const mcp = await customerClient(ctx);
    await mcp.call("find_offers", { intent: "sneakers" });
    const later = new Date(Date.now() + 40 * 24 * 3600 * 1000);
    expect((await services.intent.stats(ctx, { now: later })).findOffers).toBe(0);
    expect((await services.intent.stats(other)).findOffers).toBe(0);
  });
});

describe("public endpoint", () => {
  const url = (slug: string) => `http://localhost/api/mcp/public/${slug}`;

  async function publicStore() {
    return newStore();
  }

  async function call(
    slug: string,
    name: string,
    args: Record<string, unknown>,
    ip = "203.0.113.7",
  ) {
    const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
    const res = await handlePublicMcp(
      mcpRequest(url(slug), body, { "x-real-ip": ip }),
      slug,
      services,
      null,
    );
    const json = (await res.json()) as {
      result?: { isError?: boolean; content?: { text: string }[] };
      error?: unknown;
    };
    const text = json.result?.content?.[0]?.text ?? "";
    const failed = json.error !== undefined || json.result?.isError === true;
    return { failed, text, data: failed ? null : (JSON.parse(text) as unknown) };
  }

  async function names(slug: string) {
    const res = await handlePublicMcp(
      mcpRequest(url(slug), { jsonrpc: "2.0", id: 1, method: "tools/list" }),
      slug,
      services,
      null,
    );
    const json = (await res.json()) as { result: { tools: { name: string }[] } };
    return json.result.tools.map((t) => t.name).sort();
  }

  it("answers find_offers without credentials and links to the store page", async () => {
    const ctx = await publicStore();
    const res = await call(ctx.slug, "find_offers", {
      intent: "black sneakers size 10 US under 75k",
    });
    expect(res.failed).toBe(false);
    const data = res.data as FindResult;
    expect(data.offers.map((o) => o.title)).toEqual(["Nordix Hightop Classic"]);
    expect(data.offers[0]?.url).toMatch(
      new RegExp(`/s/${ctx.slug}/offers/${data.offers[0]?.offer_id}$`),
    );
  });

  it("serves the read-only raw tools and the same results through raw_hint", async () => {
    const ctx = await publicStore();
    const found = (await call(ctx.slug, "find_offers", { intent: "men boots 27.5 cm" }))
      .data as FindResult;
    const raw = await call(ctx.slug, "search_offers", found.raw_hint.arguments);
    expect(raw.failed).toBe(false);
    const rawIds = (raw.data as { offers: { offer_id: string }[] }).offers.map((o) => o.offer_id);
    expect(rawIds.sort()).toEqual(
      [...found.offers, ...found.on_request].map((o) => o.offer_id).sort(),
    );

    const id = found.offers[0]!.offer_id;
    expect((await call(ctx.slug, "get_offer_details", { offer_id: id })).failed).toBe(false);
    expect((await call(ctx.slug, "check_availability", { offer_ids: [id] })).failed).toBe(false);
    const second = found.offers[1]!.offer_id;
    expect((await call(ctx.slug, "compare_offers", { offer_ids: [id, second] })).failed).toBe(
      false,
    );
  });

  it("links raw calls to the find_offers of the same caller, per store", async () => {
    const ctx = await publicStore();
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    const found = (await call(ctx.slug, "find_offers", { intent: "sneakers" }, ip))
      .data as FindResult;
    await call(ctx.slug, "search_offers", { query: "Nordix" }, ip);
    await call(ctx.slug, "search_offers", { query: "Velor" }, "192.0.2.99");

    const events = await db
      .select()
      .from(intentEvents)
      .where(eq(intentEvents.tenantId, ctx.tenantId));
    const rawEvents = events.filter((e) => e.kind === "search_offers");
    expect(rawEvents).toHaveLength(1);
    expect(rawEvents[0]?.afterIntentId).toBe(found.intent_id);
    expect(await services.intent.stats(ctx)).toMatchObject({ findOffers: 1, followedByRaw: 1 });
  });

  it("takes report_answer from outside and audits it", async () => {
    const ctx = await publicStore();
    const found = (await call(ctx.slug, "find_offers", { intent: "sneakers" })).data as FindResult;
    const res = await call(ctx.slug, "report_answer", {
      intent_id: found.intent_id,
      verdict: "wrong",
    });
    expect(res.failed).toBe(false);
    const audit = await services.audit.list(ctx, {
      actor: "customer_agent",
      entity: "intent_event",
    });
    expect(audit.map((a) => a.action)).toEqual(["intent.reported"]);
  });

  it("hides the raw tools when PUBLIC_RAW_TOOLS is 0 but keeps find_offers", async () => {
    process.env.PUBLIC_RAW_TOOLS = "0";
    const ctx = await publicStore();
    expect(await names(ctx.slug)).toEqual(["find_offers", "report_answer", "talk_to_store"]);
    expect((await call(ctx.slug, "search_offers", { query: "Runner" })).failed).toBe(true);
    expect((await call(ctx.slug, "find_offers", { intent: "sneakers" })).failed).toBe(false);
  });

  it("keeps the raw tools on for any other value", async () => {
    process.env.PUBLIC_RAW_TOOLS = "1";
    const ctx = await publicStore();
    expect(await names(ctx.slug)).toContain("search_offers");
  });

  it("never offers order or inquiry tools directly", async () => {
    const ctx = await publicStore();
    const list = await names(ctx.slug);
    expect(list).not.toContain("create_order");
    expect(list).not.toContain("submit_inquiry");
    expect((await call(ctx.slug, "create_order", { items: [] })).failed).toBe(true);
  });

  it("does not run raw tools against another store", async () => {
    const mine = await publicStore();
    const other = await publicStore();
    const found = (await call(mine.slug, "find_offers", { intent: "sneakers" })).data as FindResult;
    const stolen = await call(other.slug, "get_offer_details", {
      offer_id: found.offers[0]!.offer_id,
    });
    expect(stolen.failed).toBe(true);
    const audits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.tenantId, other.tenantId));
    expect(audits.filter((a) => a.action === "intent.reported")).toEqual([]);
  });
});
