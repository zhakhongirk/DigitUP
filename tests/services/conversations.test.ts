import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { conversations } from "@/db/schema";
import { EVENTS } from "@/server/events/types";
import { createAuditService } from "@/server/services/audit";
import { createCatalogService } from "@/server/services/catalog";
import { createConversationsService } from "@/server/services/conversations";
import { createOrdersService } from "@/server/services/orders";
import { createTestTenant, recordingEvents, testDb } from "../helpers/db";

function setup() {
  const db = testDb();
  const events = recordingEvents();
  return { db, events, service: createConversationsService({ db, events }) };
}

describe("conversations service", () => {
  it("reuses a conversation by sessionKey within a channel", async () => {
    const { service } = setup();
    const ctx = await createTestTenant();
    const a = await service.getOrCreate(ctx, {
      agent: "customer",
      channel: "storefront",
      sessionKey: "s1",
    });
    const again = await service.getOrCreate(ctx, {
      agent: "customer",
      channel: "storefront",
      sessionKey: "s1",
    });
    const otherKey = await service.getOrCreate(ctx, {
      agent: "customer",
      channel: "storefront",
      sessionKey: "s2",
    });
    const otherChannel = await service.getOrCreate(ctx, {
      agent: "customer",
      channel: "external_agent",
      sessionKey: "s1",
    });
    expect(again.id).toBe(a.id);
    expect(new Set([a.id, otherKey.id, otherChannel.id]).size).toBe(3);

    const x = await service.getOrCreate(ctx, { agent: "business", channel: "workspace" });
    const y = await service.getOrCreate(ctx, { agent: "business", channel: "workspace" });
    expect(x.id).not.toBe(y.id);
  });

  it("yields a single conversation for concurrent getOrCreate", async () => {
    const { service, db } = setup();
    const ctx = await createTestTenant();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.getOrCreate(ctx, { agent: "customer", channel: "storefront", sessionKey: "race" }),
      ),
    );
    expect(new Set(results.map((c) => c.id)).size).toBe(1);
    const audit = await createAuditService(db).list(ctx, { entity: "conversation" });
    expect(audit.filter((e) => e.action === "conversation.created")).toHaveLength(0);
  });

  it("keeps insertion order across appends", async () => {
    const { service } = setup();
    const ctx = await createTestTenant();
    const conv = await service.getOrCreate(ctx, { agent: "business", channel: "workspace" });
    await service.appendMessages(ctx, conv.id, [
      { role: "user", content: "1" },
      { role: "assistant", content: "2", toolCalls: [{ name: "x" }] },
      { role: "tool", content: "3" },
    ]);
    await service.appendMessages(ctx, conv.id, [
      { role: "user", content: "4" },
      { role: "assistant", content: null },
    ]);
    const all = await service.listMessages(ctx, conv.id);
    expect(all.map((m) => m.content)).toEqual(["1", "2", "3", "4", null]);
    expect(all[1]?.toolCalls).toEqual([{ name: "x" }]);
    expect(all[0]?.toolCalls).toBeNull();
    expect(await service.appendMessages(ctx, conv.id, [])).toEqual([]);
  });

  it("listMessages returns the last N oldest-first", async () => {
    const { service } = setup();
    const ctx = await createTestTenant();
    const conv = await service.getOrCreate(ctx, { agent: "business", channel: "workspace" });
    await service.appendMessages(
      ctx,
      conv.id,
      Array.from({ length: 6 }, (_, i) => ({ role: "user" as const, content: `m${i}` })),
    );
    const last = await service.listMessages(ctx, conv.id, { limit: 3 });
    expect(last.map((m) => m.content)).toEqual(["m3", "m4", "m5"]);
    await expect(service.listMessages(ctx, conv.id, { limit: 0 })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("publishes events only for user messages", async () => {
    const { service, events } = setup();
    const ctx = await createTestTenant();
    const conv = await service.getOrCreate(ctx, { agent: "customer", channel: "storefront" });
    const inserted = await service.appendMessages(ctx, conv.id, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "again" },
    ]);
    const users = inserted.filter((m) => m.role === "user");
    expect(events.ofType(EVENTS.conversationMessage)).toEqual(
      users.map((m) => ({ tenantId: ctx.tenantId, conversationId: conv.id, messageId: m.id })),
    );
    expect(events.events.map((e) => e.options?.singletonKey)).toEqual(users.map((m) => m.id));
  });

  it("setStatus updates, audits and lists by filter", async () => {
    const { service, db } = setup();
    const ctx = await createTestTenant();
    const conv = await service.getOrCreate(ctx, { agent: "customer", channel: "storefront" });
    const updated = await service.setStatus(ctx, conv.id, "completed");
    expect(updated.status).toBe("completed");
    const audit = await createAuditService(db).list(ctx, { entity: "conversation" });
    const changed = audit.find((e) => e.action === "conversation.status_changed");
    expect(changed?.entityId).toBe(conv.id);
    expect(changed?.before).toEqual({ status: "new" });
    expect(changed?.after).toEqual({ status: "completed" });
    expect(audit.some((e) => e.action === "conversation.created")).toBe(false);

    const done = await service.list(ctx, { status: "completed" });
    expect(done.map((c) => c.id)).toEqual([conv.id]);
    expect(await service.list(ctx, { status: "in_progress" })).toEqual([]);
  });

  it("isolates tenants", async () => {
    const { service } = setup();
    const a = await createTestTenant();
    const b = await createTestTenant();
    const conv = await service.getOrCreate(a, { agent: "business", channel: "workspace" });
    await service.appendMessages(a, conv.id, [{ role: "user", content: "secret" }]);

    expect(await service.get(b, conv.id)).toBeNull();
    expect(await service.list(b)).toEqual([]);
    await expect(
      service.appendMessages(b, conv.id, [{ role: "user", content: "x" }]),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(service.listMessages(b, conv.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(service.setStatus(b, conv.id, "completed")).rejects.toMatchObject({
      code: "not_found",
    });

    const after = await service.listMessages(a, conv.id);
    expect(after.map((m) => m.content)).toEqual(["secret"]);
    expect((await service.get(a, conv.id))?.status).toBe("new");

    // Same session key in another tenant is a different conversation.
    const s1 = await service.getOrCreate(a, {
      agent: "customer",
      channel: "storefront",
      sessionKey: "k",
    });
    const s2 = await service.getOrCreate(b, {
      agent: "customer",
      channel: "storefront",
      sessionKey: "k",
    });
    expect(s1.id).not.toBe(s2.id);
  });
});

describe("conversation stats", () => {
  const since = () => new Date(Date.now() - 24 * 3600 * 1000);

  it("counts channels and links to orders and inquiries", async () => {
    const { db, events, service } = setup();
    const ctx = await createTestTenant();
    const orders = createOrdersService({ db, events });
    const open = (channel: "storefront" | "external_agent") =>
      service.getOrCreate(ctx, { agent: "customer", channel });
    const ordered = await open("storefront");
    const drafted = await open("storefront");
    const asked = await open("external_agent");
    const both = await open("storefront");
    await open("storefront");
    await service.getOrCreate(ctx, { agent: "business", channel: "workspace" });

    const catalog = createCatalogService({ db, events });
    await catalog.applyBusinessModel(ctx, {
      profile: { name: "Shop" },
      offer_types: [{ key: "item", name: "Item", kind: "product", attributes: [] }],
      offers: [
        {
          title: "Alpha",
          offer_type: "item",
          price: 10,
          currency: "KZT",
          price_status: "confirmed",
          availability: "in_stock",
        },
      ],
    });
    const { items } = await catalog.searchOffers(ctx, { statuses: ["active"], limit: 10 });
    const offerId = items[0]!.id;
    let n = 0;
    const order = async (conversationId: string, submit: boolean) => {
      const { order: created } = await orders.createOrder(ctx, {
        idempotencyKey: `stats-key-${n++}-${conversationId}`,
        source: "storefront",
        items: [{ offerId, quantity: 1 }],
        contact: { name: "Ann", phone: "+7 701 000 11 22" },
        fulfillment: "pickup",
        conversationId,
      });
      if (submit) await orders.submitOrder(ctx, created.id);
    };
    await order(ordered.id, true);
    await order(drafted.id, false);
    await order(both.id, true);
    await orders.createInquiry(ctx, { subject: "Q", conversationId: asked.id });
    await orders.createInquiry(ctx, { subject: "Q", conversationId: both.id });

    expect(await service.stats(ctx, { since: since() })).toEqual({
      total: 5,
      byChannel: { storefront: 4, external_agent: 1, workspace: 0 },
      withOrder: 2,
      withInquiry: 2,
      withOutcome: 3,
    });
  });

  it("respects since, tenant and owner-only access", async () => {
    const { db, service } = setup();
    const ctx = await createTestTenant();
    const other = await createTestTenant();
    const old = await service.getOrCreate(ctx, { agent: "customer", channel: "storefront" });
    await service.getOrCreate(ctx, { agent: "customer", channel: "storefront" });
    await service.getOrCreate(other, { agent: "customer", channel: "storefront" });
    await db
      .update(conversations)
      .set({ createdAt: new Date(Date.now() - 10 * 24 * 3600 * 1000) })
      .where(eq(conversations.id, old.id));

    expect((await service.stats(ctx, { since: since() })).total).toBe(1);
    expect((await service.stats(other, { since: since() })).total).toBe(1);
    await expect(
      service.stats({ ...ctx, actor: "customer_agent" }, { since: since() }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("firstUserMessages", () => {
  const since = () => new Date(Date.now() - 24 * 3600 * 1000);

  it("returns the earliest non-empty user message per conversation", async () => {
    const { service } = setup();
    const ctx = await createTestTenant();
    const a = await service.getOrCreate(ctx, { agent: "customer", channel: "storefront" });
    const b = await service.getOrCreate(ctx, { agent: "customer", channel: "storefront" });
    const workspace = await service.getOrCreate(ctx, { agent: "business", channel: "workspace" });
    await service.appendMessages(ctx, a.id, [
      { role: "system", content: "rules" },
      { role: "user", content: "  " },
      { role: "user", content: "first question" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second question" },
    ]);
    await service.appendMessages(ctx, b.id, [{ role: "user", content: "other chat" }]);
    await service.appendMessages(ctx, workspace.id, [{ role: "user", content: "owner note" }]);

    const rows = await service.firstUserMessages(ctx, { since: since() });
    expect(rows.map((r) => [r.conversationId, r.content])).toEqual([
      [b.id, "other chat"],
      [a.id, "first question"],
    ]);
    expect(await service.firstUserMessages(ctx, { since: since(), limit: 1 })).toHaveLength(1);
  });

  it("respects since, tenant and owner-only access", async () => {
    const { db, service } = setup();
    const ctx = await createTestTenant();
    const other = await createTestTenant();
    const old = await service.getOrCreate(ctx, { agent: "customer", channel: "storefront" });
    const fresh = await service.getOrCreate(ctx, { agent: "customer", channel: "storefront" });
    const foreign = await service.getOrCreate(other, { agent: "customer", channel: "storefront" });
    await service.appendMessages(ctx, old.id, [{ role: "user", content: "old" }]);
    await service.appendMessages(ctx, fresh.id, [{ role: "user", content: "fresh" }]);
    await service.appendMessages(other, foreign.id, [{ role: "user", content: "foreign" }]);
    await db
      .update(conversations)
      .set({ createdAt: new Date(Date.now() - 10 * 24 * 3600 * 1000) })
      .where(eq(conversations.id, old.id));

    const rows = await service.firstUserMessages(ctx, { since: since() });
    expect(rows.map((r) => r.content)).toEqual(["fresh"]);
    await expect(
      service.firstUserMessages({ ...ctx, actor: "business_agent" }, { since: since() }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("conversation daily counts", () => {
  it("groups customer conversations by day in the time zone", async () => {
    const { db, service } = setup();
    const ctx = await createTestTenant();
    const early = await service.getOrCreate(ctx, { agent: "customer", channel: "storefront" });
    const late = await service.getOrCreate(ctx, { agent: "customer", channel: "storefront" });
    await service.getOrCreate(ctx, { agent: "customer", channel: "storefront" });
    await service.getOrCreate(ctx, { agent: "business", channel: "workspace" });
    await db
      .update(conversations)
      .set({ createdAt: new Date("2026-11-01T22:30:00Z") })
      .where(eq(conversations.id, early.id));
    await db
      .update(conversations)
      .set({ createdAt: new Date("2026-11-02T01:00:00Z") })
      .where(eq(conversations.id, late.id));
    const since = new Date("2026-10-30T00:00:00Z");

    const utc = await service.dailyCounts(ctx, { since, timeZone: "UTC" });
    expect(utc.filter((row) => row.day < "2026-11-03")).toEqual([
      { day: "2026-11-01", count: 1 },
      { day: "2026-11-02", count: 1 },
    ]);
    const almaty = await service.dailyCounts(ctx, { since, timeZone: "Asia/Almaty" });
    expect(almaty.filter((row) => row.day < "2026-11-03")).toEqual([
      { day: "2026-11-02", count: 2 },
    ]);
    await expect(
      service.dailyCounts({ ...ctx, actor: "customer_agent" }, { since, timeZone: "UTC" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
