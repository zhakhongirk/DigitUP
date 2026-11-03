import { describe, expect, it } from "vitest";
import { auditEvents } from "@/db/schema";
import { createAuditService, recordAudit } from "@/server/services/audit";
import { createTestTenant, testDb } from "../helpers/db";

describe("audit paging", () => {
  it("pages newest first, counts per tenant and clamps the offset", async () => {
    const db = testDb();
    const ctx = await createTestTenant({ actor: "owner" });
    const other = await createTestTenant({ actor: "owner" });
    const audit = createAuditService(db);
    const base = await audit.count(ctx);
    const otherBase = await audit.count(other);
    for (let i = 0; i < 5; i++) {
      await recordAudit(db, ctx, { action: `thing.${i}`, entity: "thing" });
    }
    await recordAudit(db, other, { action: "thing.other", entity: "thing" });

    expect(await audit.count(ctx)).toBe(base + 5);
    expect(await audit.count(other)).toBe(otherBase + 1);

    const all = (await audit.list(ctx)).map((e) => e.id);
    const paged = [
      ...(await audit.list(ctx, { limit: 2, offset: 0 })),
      ...(await audit.list(ctx, { limit: 2, offset: 2 })),
      ...(await audit.list(ctx, { limit: 2, offset: 4 })),
      ...(await audit.list(ctx, { limit: 2, offset: 6 })),
    ].map((e) => e.id);
    expect(paged).toEqual(all);
    expect(await audit.list(ctx, { limit: 2, offset: 100 })).toHaveLength(0);
    expect((await audit.list(ctx, { limit: 2, offset: -3 })).map((e) => e.id)).toEqual(
      all.slice(0, 2),
    );
  });

  it("pages past 500 rows", async () => {
    const db = testDb();
    const ctx = await createTestTenant({ actor: "owner" });
    const audit = createAuditService(db);
    const base = await audit.count(ctx);
    await Promise.all(
      Array.from({ length: 12 }, (_, chunk) =>
        db.insert(auditEvents).values(
          Array.from({ length: 50 }, (_, i) => ({
            tenantId: ctx.tenantId,
            actor: ctx.actor,
            action: `bulk.${chunk * 50 + i}`,
            entity: "thing",
          })),
        ),
      ),
    );
    const total = await audit.count(ctx);
    expect(total).toBe(base + 600);
    const seen = new Set<string>();
    for (let offset = 0; offset < total; offset += 50) {
      for (const event of await audit.list(ctx, { limit: 50, offset })) seen.add(event.id);
    }
    expect(seen.size).toBe(total);
  });

  it("filters list and count by actor", async () => {
    const db = testDb();
    const ctx = await createTestTenant({ actor: "owner" });
    const audit = createAuditService(db);
    await recordAudit(db, ctx, { action: "thing.a", entity: "thing" });
    await recordAudit(db, { ...ctx, actor: "system" }, { action: "thing.b", entity: "thing" });
    await recordAudit(db, { ...ctx, actor: "system" }, { action: "thing.c", entity: "thing" });

    const system = await audit.list(ctx, { actor: "system" });
    expect(system.every((e) => e.actor === "system")).toBe(true);
    expect(system.map((e) => e.action)).toEqual(expect.arrayContaining(["thing.b", "thing.c"]));
    expect(system).toHaveLength(await audit.count(ctx, { actor: "system" }));
    expect(await audit.count(ctx, { actor: "customer_agent" })).toBe(0);
  });
});
