import { describe, expect, it } from "vitest";
import { EVENTS } from "@/server/events/types";
import { createAuditService } from "@/server/services/audit";
import { createConversationsService } from "@/server/services/conversations";
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
    expect(audit.filter((e) => e.action === "conversation.created")).toHaveLength(1);
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
    expect(audit.some((e) => e.action === "conversation.created")).toBe(true);

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
