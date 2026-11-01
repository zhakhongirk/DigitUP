import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notifications } from "@/db/schema";
import { PgBossEventPublisher, startBoss } from "@/server/events/boss";
import { handlers } from "@/server/events/handlers";
import { EVENTS } from "@/server/events/types";
import { createTestTenant, testDb } from "../helpers/db";
import { testDatabaseUrl } from "../helpers/test-db-url";

describe("event handlers", () => {
  it("creates one owner notification per submitted order, even when the job repeats", async () => {
    const db = testDb();
    const ctx = await createTestTenant();
    const orderId = randomUUID();

    await handlers[EVENTS.orderSubmitted]({ tenantId: ctx.tenantId, orderId }, { db });
    await handlers[EVENTS.orderSubmitted]({ tenantId: ctx.tenantId, orderId }, { db });

    const rows = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.tenantId, ctx.tenantId), eq(notifications.refId, orderId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("order");
  });

  it("acknowledges events that have no consumer yet", async () => {
    const log: string[] = [];
    await handlers[EVENTS.conversationMessage](
      { tenantId: randomUUID(), conversationId: randomUUID(), messageId: randomUUID() },
      { db: testDb(), log: (m) => log.push(m) },
    );
    expect(log[0]).toMatch(/conversation\.message/);
  });
});

describe("transactional publishing through pg-boss", () => {
  let boss: PgBoss;

  beforeAll(async () => {
    boss = await startBoss({ connectionString: testDatabaseUrl(), supervise: false });
  });
  afterAll(async () => {
    await boss.stop({ graceful: false });
  });

  async function findInquiryJob(inquiryId: string) {
    const jobs = await boss.findJobs<{ inquiryId: string }>(EVENTS.inquirySubmitted, {
      data: { inquiryId },
    });
    return jobs;
  }

  it("enqueues the job when the transaction commits", async () => {
    const publisher = new PgBossEventPublisher(boss);
    const inquiryId = randomUUID();

    await testDb().transaction(async (tx) => {
      await publisher.publish(tx, EVENTS.inquirySubmitted, { tenantId: randomUUID(), inquiryId });
    });

    expect(await findInquiryJob(inquiryId)).toHaveLength(1);
  });

  it("drops the job when the transaction rolls back", async () => {
    const publisher = new PgBossEventPublisher(boss);
    const inquiryId = randomUUID();

    await expect(
      testDb().transaction(async (tx) => {
        await publisher.publish(tx, EVENTS.inquirySubmitted, {
          tenantId: randomUUID(),
          inquiryId,
        });
        throw new Error("write failed");
      }),
    ).rejects.toThrow("write failed");

    expect(await findInquiryJob(inquiryId)).toHaveLength(0);
  });

  it("deduplicates by singleton key", async () => {
    const publisher = new PgBossEventPublisher(boss);
    const inquiryId = randomUUID();
    const data = { tenantId: randomUUID(), inquiryId };

    await publisher.publish(testDb(), EVENTS.inquirySubmitted, data, { singletonKey: inquiryId });
    await publisher.publish(testDb(), EVENTS.inquirySubmitted, data, { singletonKey: inquiryId });

    expect(await findInquiryJob(inquiryId)).toHaveLength(1);
  });
});
