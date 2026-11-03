import { afterEach, describe, expect, it, vi } from "vitest";
import { shoeStoreModel } from "@/db/seed-data/shoe-store";
import { handlers } from "@/server/events/handlers";
import { EVENTS } from "@/server/events/types";
import { createCustomerMcpServer } from "@/server/mcp/customer/server";
import type { OfferView } from "@/server/services/catalog";
import {
  classifyStatus,
  deliverWithRetry,
  type PostWebhook,
} from "@/server/services/webhooks/deliver";
import {
  assertPublicWebhookUrl,
  isPrivateAddress,
  parseWebhookUrl,
  WebhookUrlError,
} from "@/server/services/webhooks/guard";
import { createWebhookService } from "@/server/services/webhooks";
import {
  SIGNATURE_HEADER,
  signWebhook,
  TIMESTAMP_HEADER,
  verifyWebhook,
  webhookHeaders,
} from "@/server/services/webhooks/sign";
import { storeLlmsTxt } from "@/server/storefront/llms";
import { createTestTenant, testDb } from "../helpers/db";
import { connect, testServices } from "../helpers/mcp";

describe("webhook signature", () => {
  it("signs timestamp and body with HMAC-SHA256", () => {
    const sig = signWebhook("whsec_x", 1700000000, '{"a":1}');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(sig).toBe(signWebhook("whsec_x", 1700000000, '{"a":1}'));
    expect(sig).not.toBe(signWebhook("whsec_y", 1700000000, '{"a":1}'));
    expect(sig).not.toBe(signWebhook("whsec_x", 1700000001, '{"a":1}'));
    expect(sig).not.toBe(signWebhook("whsec_x", 1700000000, '{"a":2}'));
  });

  it("puts the signature and timestamp in headers and verifies them", () => {
    const body = '{"event":"order.status_changed"}';
    const headers = webhookHeaders("secret", body, 1700000000_500);
    expect(headers[TIMESTAMP_HEADER]).toBe("1700000000");
    expect(verifyWebhook("secret", 1700000000, body, headers[SIGNATURE_HEADER])).toBe(true);
    expect(verifyWebhook("other", 1700000000, body, headers[SIGNATURE_HEADER])).toBe(false);
    expect(verifyWebhook("secret", 1700000000, body, "sha256=bad")).toBe(false);
  });
});

describe("SSRF guard", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "64:ff9b::7f00:1",
  ])("treats %s as private", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "93.184.216.34", "2606:4700:4700::1111"])(
    "treats %s as public",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );

  it("rejects non-https, credentials, localhost and private literals", () => {
    for (const url of [
      "http://example.com/hook",
      "ftp://example.com",
      "https://user:pw@example.com/",
      "https://localhost/hook",
      "https://api.localhost/hook",
      "https://127.0.0.1/hook",
      "https://[::1]/hook",
      "https://169.254.169.254/latest",
      "not a url",
    ]) {
      expect(() => parseWebhookUrl(url), url).toThrow(WebhookUrlError);
    }
    expect(parseWebhookUrl("https://example.com/hook").hostname).toBe("example.com");
  });

  it("rejects hosts that resolve to private addresses and accepts public ones", async () => {
    await expect(
      assertPublicWebhookUrl("https://evil.example/h", async () => ["93.184.216.34", "10.0.0.5"]),
    ).rejects.toThrow(WebhookUrlError);
    await expect(
      assertPublicWebhookUrl("https://evil.example/h", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toThrow(WebhookUrlError);
    await expect(
      assertPublicWebhookUrl("https://ok.example/h", async () => ["93.184.216.34"]),
    ).resolves.toBeInstanceOf(URL);
  });
});

describe("delivery with retry", () => {
  const base = { url: "https://ok.example/h", secret: "s", body: "{}", now: () => 1000 };

  it("classifies statuses", () => {
    expect(classifyStatus(204)).toBe("ok");
    expect(classifyStatus(500)).toBe("retry");
    expect(classifyStatus(429)).toBe("retry");
    expect(classifyStatus(404)).toBe("fail");
  });

  it("delivers on the first try with signed headers", async () => {
    const post = vi.fn<PostWebhook>(async () => ({ status: 200 }));
    const outcome = await deliverWithRetry({ ...base, post, sleep: async () => {} });
    expect(outcome).toEqual({ ok: true, attempts: 1 });
    const [, headers] = post.mock.calls[0]!;
    expect(headers[SIGNATURE_HEADER]).toBe(signWebhook("s", 1, "{}"));
  });

  it("retries with growing backoff until it succeeds", async () => {
    const sleeps: number[] = [];
    const post = vi
      .fn<PostWebhook>()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce({ status: 503 })
      .mockResolvedValueOnce({ status: 200 });
    const outcome = await deliverWithRetry({
      ...base,
      post,
      backoffMs: [10, 40],
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(outcome).toEqual({ ok: true, attempts: 3 });
    expect(sleeps).toEqual([10, 40]);
  });

  it("reports a retryable failure after the last attempt", async () => {
    const post = vi.fn<PostWebhook>(async () => ({ status: 502 }));
    const outcome = await deliverWithRetry({
      ...base,
      post,
      backoffMs: [1, 2],
      sleep: async () => {},
    });
    expect(post).toHaveBeenCalledTimes(3);
    expect(outcome).toMatchObject({ ok: false, retryable: true, attempts: 3 });
  });

  it("does not retry a permanent client error", async () => {
    const post = vi.fn<PostWebhook>(async () => ({ status: 410 }));
    const outcome = await deliverWithRetry({ ...base, post, sleep: async () => {} });
    expect(post).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ ok: false, retryable: false });
  });
});

describe("webhook registration and notifications", () => {
  const services = testServices();
  const resolver = async () => ["93.184.216.34"];
  const open: Awaited<ReturnType<typeof connect>>[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((c) => c.close()));
  });

  async function store() {
    const ctx = await createTestTenant({ actor: "customer_agent", live: true });
    await services.catalog.applyBusinessModel({ ...ctx, actor: "system" }, shoeStoreModel);
    const webhooks = createWebhookService(testDb(), resolver);
    const client = await connect(
      createCustomerMcpServer({ ctx, services, source: "external_agent", webhooks }),
    );
    open.push(client);
    return { ctx, webhooks, client };
  }

  it("sets, rotates and clears the webhook through MCP", async () => {
    const { ctx, webhooks, client } = await store();
    const first = await client.call("set_webhook", { url: "https://agent.example/hook" });
    expect(first.isError).toBe(false);
    const { secret } = first.data as { url: string; secret: string };
    expect(secret).toMatch(/^whsec_/);
    expect(await webhooks.get(ctx.tenantId)).toEqual({
      url: "https://agent.example/hook",
      secret,
    });

    const second = await client.call("set_webhook", { url: "https://agent.example/hook" });
    expect((second.data as { secret: string }).secret).not.toBe(secret);

    const cleared = await client.call("clear_webhook");
    expect(cleared.data).toEqual({ cleared: true });
    expect(await webhooks.get(ctx.tenantId)).toBeNull();
  });

  it("refuses unsafe URLs", async () => {
    const { client } = await store();
    for (const url of ["http://agent.example/hook", "https://127.0.0.1/hook"]) {
      expect((await client.call("set_webhook", { url })).isError).toBe(true);
    }
  });

  it("does not offer webhook tools without the webhooks service", async () => {
    const ctx = await createTestTenant({ actor: "customer_agent", live: true });
    const client = await connect(createCustomerMcpServer({ ctx, services, source: "storefront" }));
    open.push(client);
    expect(await client.toolNames()).not.toContain("set_webhook");
  });

  it("publishes a status event for agent orders and delivers it signed", async () => {
    const { ctx, webhooks, client } = await store();
    const owner = { tenantId: ctx.tenantId, actor: "owner" as const };
    const { items } = await services.catalog.searchOffers(ctx, { limit: 200 });
    const offer = items.find(
      (o: OfferView) => o.priceStatus === "confirmed" && o.availability === "in_stock",
    )!;
    const placed = await client.call("create_order", {
      idempotency_key: `k-${Math.random().toString(36).slice(2)}-abc`,
      items: [{ offer_id: offer.id, quantity: 1 }],
      contact: { name: "A", phone: "+77001234567" },
      fulfillment: "pickup",
      submit: true,
    });
    const orderId = (placed.data as { order_id: string }).order_id;

    await services.orders.updateOrderStatus(owner, orderId, "received");
    const mine = services.events
      .ofType(EVENTS.agentStatusChanged)
      .filter((e) => e.entityId === orderId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      kind: "order",
      status: "received",
      previousStatus: "submitted",
    });

    const { secret, url } = await webhooks.set(ctx.tenantId, "https://agent.example/hook");
    const post = vi.fn<PostWebhook>(async () => ({ status: 200 }));
    await handlers[EVENTS.agentStatusChanged](mine[0]!, {
      db: testDb(),
      webhooks,
      postWebhook: post,
      sleep: async () => {},
    });
    expect(post).toHaveBeenCalledTimes(1);
    const [calledUrl, headers, body] = post.mock.calls[0]!;
    expect(calledUrl).toBe(url);
    expect(JSON.parse(body)).toMatchObject({
      event: "order.status_changed",
      id: orderId,
      status: "received",
      previous_status: "submitted",
    });
    expect(
      verifyWebhook(secret, Number(headers[TIMESTAMP_HEADER]), body, headers[SIGNATURE_HEADER]!),
    ).toBe(true);
  });

  it("does not publish for orders placed from the storefront", async () => {
    const ctx = await createTestTenant({ actor: "customer_agent", live: true });
    await services.catalog.applyBusinessModel({ ...ctx, actor: "system" }, shoeStoreModel);
    const { items } = await services.catalog.searchOffers(ctx, { limit: 200 });
    const offer = items.find(
      (o) => o.priceStatus === "confirmed" && o.availability === "in_stock",
    )!;
    const { order } = await services.orders.createOrder(ctx, {
      idempotencyKey: `s-${Math.random().toString(36).slice(2)}-abc`,
      items: [{ offerId: offer.id, quantity: 1 }],
      contact: { name: "A", phone: "+77001234567" },
      fulfillment: "pickup",
      source: "storefront",
    });
    await services.orders.submitOrder(ctx, order.id);
    await services.orders.updateOrderStatus(
      { tenantId: ctx.tenantId, actor: "owner" },
      order.id,
      "received",
    );
    expect(
      services.events.ofType(EVENTS.agentStatusChanged).filter((e) => e.entityId === order.id),
    ).toHaveLength(0);
  });

  it("stays silent without a webhook and fails the job on a retryable error", async () => {
    const { ctx, webhooks } = await store();
    const payload = {
      tenantId: ctx.tenantId,
      kind: "inquiry" as const,
      entityId: "00000000-0000-4000-8000-000000000000",
      status: "completed",
      previousStatus: "new",
      changedAt: new Date().toISOString(),
    };
    const post = vi.fn<PostWebhook>(async () => ({ status: 500 }));
    const deps = { db: testDb(), webhooks, postWebhook: post, sleep: async () => {} };
    await handlers[EVENTS.agentStatusChanged](payload, deps);
    expect(post).not.toHaveBeenCalled();

    await webhooks.set(ctx.tenantId, "https://agent.example/hook");
    await expect(handlers[EVENTS.agentStatusChanged](payload, deps)).rejects.toThrow(
      /Webhook delivery failed/,
    );
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("documents the webhook in llms.txt", () => {
    const text = storeLlmsTxt({ baseUrl: "https://x.test", slug: "a", name: "A" });
    expect(text).toContain("set_webhook");
    expect(text).toContain(SIGNATURE_HEADER);
    expect(text).not.toContain("—");
  });
});
