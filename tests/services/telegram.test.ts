import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { changeSets, inquiries, kv, notifications, orders, tenants } from "@/db/schema";
import { handlers } from "@/server/events/handlers";
import { EVENTS } from "@/server/events/types";
import { ServiceError } from "@/server/services/context";
import {
  createTelegramService,
  orderDetailLines,
  LINK_CODE_TTL_MS,
  type TelegramClient,
  type TelegramUpdate,
} from "@/server/services/telegram";
import { createTestTenant, testDb } from "../helpers/db";

class FakeTelegram implements TelegramClient {
  sent: { chatId: string; text: string }[] = [];
  queue: TelegramUpdate[][] = [];
  offsets: number[] = [];
  failSend = false;

  async getUpdates({ offset }: { offset: number }) {
    this.offsets.push(offset);
    return this.queue.shift() ?? [];
  }

  async sendMessage(chatId: string, text: string) {
    if (this.failSend) throw new Error("boom");
    this.sent.push({ chatId, text });
  }
}

function start(updateId: number, chatId: number, code: string): TelegramUpdate {
  return { update_id: updateId, message: { text: `/start ${code}`, chat: { id: chatId } } };
}

function setup(options: { now?: () => Date } = {}) {
  const db = testDb();
  const client = new FakeTelegram();
  const service = createTelegramService({
    db,
    client,
    botUsername: "shop_bot",
    appUrl: "https://app.example/",
    now: options.now,
  });
  return { db, client, service };
}

async function chatOf(tenantId: string) {
  const [row] = await testDb().select().from(tenants).where(eq(tenants.id, tenantId));
  return row;
}

describe("orderDetailLines", () => {
  const items = [
    {
      offerId: "a",
      title: "Trail Runner",
      quantity: 2,
      unitPrice: 1,
      currency: "KZT",
      lineTotal: 2,
      size: "42",
    },
    { offerId: "b", title: "Socks", quantity: 1, unitPrice: 1, currency: "KZT", lineTotal: 1 },
  ];

  it("lists every line with size and the delivery city", () => {
    expect(orderDetailLines({ items, deliveryAddress: "Abay 10", city: "Almaty" }, "en")).toBe(
      "\n- Trail Runner, size 42 × 2\n- Socks × 1\nDelivery: Abay 10, Almaty",
    );
  });

  it("is localized and skips a missing destination", () => {
    expect(orderDetailLines({ items: [items[0]!], deliveryAddress: null, city: null }, "ru")).toBe(
      "\n- Trail Runner, размер 42 × 2",
    );
    expect(orderDetailLines({ items: [], deliveryAddress: null, city: "Almaty" }, "ru")).toBe(
      "\nДоставка: Almaty",
    );
  });
});

describe("telegram link codes", () => {
  it("issues a link that expires after 15 minutes", async () => {
    const { service } = setup();
    const ctx = await createTestTenant();
    const before = Date.now();
    const issued = await service.issueLinkCode(ctx);
    expect(issued.url).toBe(`https://t.me/shop_bot?start=${issued.code}`);
    expect(issued.expiresAt.getTime() - before).toBeGreaterThanOrEqual(LINK_CODE_TTL_MS - 1000);
    expect(issued.expiresAt.getTime() - before).toBeLessThanOrEqual(LINK_CODE_TTL_MS + 1000);
    const status = await service.status(ctx);
    expect(status).toMatchObject({ configured: true, connected: false });
    expect(status.link?.url).toBe(issued.url);
  });

  it("connects the chat once and clears the code", async () => {
    const { service, client } = setup();
    const ctx = await createTestTenant();
    const { code } = await service.issueLinkCode(ctx);

    await service.handleUpdates([start(1, 4242, code)]);
    const row = await chatOf(ctx.tenantId);
    expect(row?.telegramChatId).toBe("4242");
    expect(row?.telegramLinkCode).toBeNull();
    expect(client.sent[0]?.text).toMatch(/^Connected/);

    await service.handleUpdates([start(2, 9999, code)]);
    expect((await chatOf(ctx.tenantId))?.telegramChatId).toBe("4242");
    expect(client.sent[1]?.text).toMatch(/invalid or has expired/);
  });

  it("rejects an expired code", async () => {
    const issuedAt = new Date(Date.now() - 2 * LINK_CODE_TTL_MS);
    const { service: early } = setup({ now: () => issuedAt });
    const ctx = await createTestTenant();
    const { code } = await early.issueLinkCode(ctx);
    expect((await early.status(ctx)).link).not.toBeNull();

    const { service, client } = setup();
    expect((await service.status(ctx)).link).toBeNull();
    await service.handleUpdates([start(1, 77, code)]);
    expect((await chatOf(ctx.tenantId))?.telegramChatId).toBeNull();
    expect(client.sent[0]?.text).toMatch(/invalid or has expired/);
  });

  it("ignores plain messages with a hint and unknown codes", async () => {
    const { service, client } = setup();
    await service.handleUpdates([
      { update_id: 1, message: { text: "/start", chat: { id: 5 } } },
      { update_id: 2, message: { text: "hello", chat: { id: 5 } } },
      start(3, 5, "nope"),
    ]);
    expect(client.sent).toHaveLength(3);
  });

  it("disconnects", async () => {
    const { service } = setup();
    const ctx = await createTestTenant();
    const { code } = await service.issueLinkCode(ctx);
    await service.handleUpdates([start(1, 1, code)]);
    await service.disconnect(ctx);
    expect((await chatOf(ctx.tenantId))?.telegramChatId).toBeNull();
    expect((await service.status(ctx)).connected).toBe(false);
  });

  it("only lets the owner manage the connection", async () => {
    const { service } = setup();
    const ctx = await createTestTenant({ actor: "customer_agent" });
    await expect(service.issueLinkCode(ctx)).rejects.toBeInstanceOf(ServiceError);
  });
});

describe("telegram polling", () => {
  it("resumes from the stored offset and advances it", async () => {
    const { db, service, client } = setup();
    const ctx = await createTestTenant();
    const { code } = await service.issueLinkCode(ctx);
    await db.delete(kv).where(eq(kv.key, "telegram.update_offset"));
    client.queue.push([start(100, 31, code), { update_id: 101 }]);

    expect(await service.pollOnce()).toBe(2);
    expect(await service.pollOnce()).toBe(0);
    expect(client.offsets).toEqual([0, 102]);
    expect((await chatOf(ctx.tenantId))?.telegramChatId).toBe("31");
  });

  it("keeps running after errors and stops on abort", async () => {
    const { service, client } = setup();
    let calls = 0;
    const controller = new AbortController();
    client.getUpdates = async () => {
      calls += 1;
      if (calls === 1) throw new Error("network");
      if (calls === 3) controller.abort();
      return [];
    };
    const errors: unknown[] = [];
    const slept: number[] = [];
    const looping = createTelegramService({
      db: testDb(),
      client,
      botUsername: "shop_bot",
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await looping.runPolling(controller.signal, (error) => errors.push(error));
    expect(errors).toHaveLength(1);
    expect(slept).toEqual([2000]);
    expect(calls).toBe(3);
    expect(service.configured).toBe(true);
  });

  it("does nothing when not configured", async () => {
    const service = createTelegramService({ db: testDb(), client: null, botUsername: null });
    expect(service.configured).toBe(false);
    await service.runPolling(new AbortController().signal);
    const ctx = await createTestTenant();
    expect(await service.status(ctx)).toEqual({ configured: false, connected: false, link: null });
    await expect(service.issueLinkCode(ctx)).rejects.toBeInstanceOf(ServiceError);
    expect(
      await service.notifyOwner({ tenantId: ctx.tenantId, kind: "order", refId: randomUUID() }),
    ).toBe(false);
  });
});

describe("telegram test message", () => {
  it("sends to the connected chat and fails when not connected", async () => {
    const { service, client } = setup();
    const ctx = await createTestTenant();
    await expect(service.sendTest(ctx)).rejects.toThrow(/not connected/);
    const { code } = await service.issueLinkCode(ctx);
    await service.handleUpdates([start(1, 808, code)]);
    await service.sendTest(ctx);
    expect(client.sent.at(-1)).toMatchObject({ chatId: "808" });
  });
});

describe("owner notifications over telegram", () => {
  async function connected() {
    const { db, service, client } = setup();
    const ctx = await createTestTenant({ live: true });
    const { code } = await service.issueLinkCode(ctx);
    await service.handleUpdates([start(1, 555, code)]);
    client.sent.length = 0;
    return { db, service, client, ctx };
  }

  it("sends a new order once, with number, customer and total", async () => {
    const { db, service, client, ctx } = await connected();
    const [order] = await db
      .insert(orders)
      .values({
        tenantId: ctx.tenantId,
        items: [],
        contact: { name: "Aigerim", phone: "+77001234567" },
        status: "submitted",
        source: "storefront",
        idempotencyKey: randomUUID(),
        total: 15000,
        currency: "KZT",
      })
      .returning();
    const payload = { tenantId: ctx.tenantId, orderId: order!.id };

    await handlers[EVENTS.orderSubmitted](payload, { db, telegram: service });
    await handlers[EVENTS.orderSubmitted](payload, { db, telegram: service });

    expect(client.sent).toHaveLength(1);
    const text = client.sent[0]!.text;
    expect(client.sent[0]!.chatId).toBe("555");
    expect(text).toContain(order!.id.replace(/-/g, "").slice(0, 6).toUpperCase());
    expect(text).toContain("Aigerim");
    expect(text).toContain("15,000 KZT");
    expect(text).toContain(`https://app.example/app/inbox?item=order:${order!.id}`);
  });

  it("writes in the language the owner saved", async () => {
    const { db, service, client, ctx } = await connected();
    await service.setLanguage(ctx, "ru");
    const [order] = await db
      .insert(orders)
      .values({
        tenantId: ctx.tenantId,
        items: [],
        contact: { name: "Aigerim" },
        status: "submitted",
        source: "storefront",
        idempotencyKey: randomUUID(),
        total: 15000,
        currency: "KZT",
      })
      .returning();

    await handlers[EVENTS.orderSubmitted](
      { tenantId: ctx.tenantId, orderId: order!.id },
      { db, telegram: service },
    );

    expect(client.sent[0]!.text).toContain("Новый заказ");
    expect(client.sent[0]!.text).toContain("15 000 ₸");
  });

  it("sends inquiries and change sets once each", async () => {
    const { db, service, client, ctx } = await connected();
    const [inquiry] = await db
      .insert(inquiries)
      .values({
        tenantId: ctx.tenantId,
        subject: "Do you have size 45?",
        contact: { name: "Dana" },
      })
      .returning();
    const [changeSet] = await db
      .insert(changeSets)
      .values({
        tenantId: ctx.tenantId,
        ops: [{ op: "a" }, { op: "b" }],
        requestedBy: "business_agent",
      })
      .returning();

    const inquiryPayload = { tenantId: ctx.tenantId, inquiryId: inquiry!.id };
    const changePayload = { tenantId: ctx.tenantId, changeSetId: changeSet!.id };
    for (let i = 0; i < 2; i++) {
      await handlers[EVENTS.inquirySubmitted](inquiryPayload, { db, telegram: service });
      await handlers[EVENTS.changeSetCreated](changePayload, { db, telegram: service });
    }

    expect(client.sent).toHaveLength(2);
    expect(client.sent[0]!.text).toContain("Do you have size 45?");
    expect(client.sent[0]!.text).toContain("Dana");
    expect(client.sent[1]!.text).toContain("2 proposed changes");
    expect(client.sent[1]!.text).toContain(`/app/approvals?id=${changeSet!.id}`);
  });

  it("does not send for tenants without a chat or for the live event", async () => {
    const { db, service, client, ctx } = await connected();
    await handlers[EVENTS.tenantLive]({ tenantId: ctx.tenantId }, { db, telegram: service });
    const other = await createTestTenant();
    await handlers[EVENTS.orderSubmitted](
      { tenantId: other.tenantId, orderId: randomUUID() },
      { db, telegram: service },
    );
    expect(client.sent).toHaveLength(0);
  });

  it("releases the claim when sending fails so a retry can deliver", async () => {
    const { db, service, client, ctx } = await connected();
    const payload = { tenantId: ctx.tenantId, orderId: randomUUID() };
    client.failSend = true;
    await handlers[EVENTS.orderSubmitted](payload, { db, telegram: service });
    expect(client.sent).toHaveLength(0);
    const [row] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.refId, payload.orderId));
    expect(row?.telegramSentAt).toBeNull();

    client.failSend = false;
    await handlers[EVENTS.orderSubmitted](payload, { db, telegram: service });
    expect(client.sent).toHaveLength(1);
  });

  it("never throws out of the handler", async () => {
    const { db, ctx } = await connected();
    const broken = {
      notifyOwner: async () => {
        throw new Error("down");
      },
    } as unknown as ReturnType<typeof createTelegramService>;
    await expect(
      handlers[EVENTS.orderSubmitted](
        { tenantId: ctx.tenantId, orderId: randomUUID() },
        { db, telegram: broken },
      ),
    ).resolves.toBeUndefined();
  });
});
