import { describe, expect, it } from "vitest";
import { notifications } from "@/db/schema";
import { createNotificationsService } from "@/server/services/notifications";
import { createTestTenant, testDb } from "../helpers/db";

async function seed(tenantId: string, n: number) {
  const db = testDb();
  const rows = [];
  for (let i = 0; i < n; i++) {
    const [row] = await db
      .insert(notifications)
      .values({ tenantId, kind: "order", refId: crypto.randomUUID() })
      .returning();
    rows.push(row!);
  }
  return rows;
}

describe("notifications service", () => {
  it("lists newest first, pages, and filters unread", async () => {
    const ctx = await createTestTenant({ actor: "owner" });
    const svc = createNotificationsService(testDb());
    const rows = await seed(ctx.tenantId, 5);
    await svc.markRead(ctx, rows[0]!.id);

    const all = await svc.list(ctx);
    expect(all).toHaveLength(5);
    const paged = [
      ...(await svc.list(ctx, { limit: 2, offset: 0 })),
      ...(await svc.list(ctx, { limit: 2, offset: 2 })),
      ...(await svc.list(ctx, { limit: 2, offset: 4 })),
    ];
    expect(paged.map((n) => n.id)).toEqual(all.map((n) => n.id));
    expect(await svc.list(ctx, { unreadOnly: true })).toHaveLength(4);
    expect(await svc.count(ctx)).toBe(5);
    expect(await svc.unreadCount(ctx)).toBe(4);
  });

  it("marks one and all read, scoped to the tenant", async () => {
    const ctx = await createTestTenant({ actor: "owner" });
    const other = await createTestTenant({ actor: "owner" });
    const svc = createNotificationsService(testDb());
    const [mine] = await seed(ctx.tenantId, 3);
    const [theirs] = await seed(other.tenantId, 1);

    const first = await svc.markRead(ctx, mine!.id);
    expect(first.readAt).toBeInstanceOf(Date);
    const again = await svc.markRead(ctx, mine!.id);
    expect(again.readAt?.getTime()).toBe(first.readAt?.getTime());

    await expect(svc.markRead(ctx, theirs!.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(svc.markRead(ctx, "nope")).rejects.toMatchObject({ code: "not_found" });

    expect(await svc.markAllRead(ctx)).toBe(2);
    expect(await svc.unreadCount(ctx)).toBe(0);
    expect(await svc.unreadCount(other)).toBe(1);
  });

  it("is owner only", async () => {
    const ctx = await createTestTenant({ actor: "owner" });
    const agent = { ...ctx, actor: "business_agent" as const };
    const svc = createNotificationsService(testDb());
    await expect(svc.list(agent)).rejects.toMatchObject({ code: "forbidden" });
    await expect(svc.unreadCount(agent)).rejects.toMatchObject({ code: "forbidden" });
    await expect(svc.markAllRead(agent)).rejects.toMatchObject({ code: "forbidden" });
  });
});
