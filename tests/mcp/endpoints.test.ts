import { describe, expect, it } from "vitest";
import { handleBusinessMcp, handleCustomerMcp } from "@/server/mcp/endpoints";
import { CUSTOMER_TOOLS } from "@/server/mcp/customer/server";
import type { BusinessModelInput } from "@/shared/business-model";
import { createTestTenant, testTenancy, uniqueSlug } from "../helpers/db";
import { mcpRequest, testServices } from "../helpers/mcp";

const services = testServices();
const tenancy = testTenancy();

const model: BusinessModelInput = {
  profile: { name: "Shoe Shop", description: "Shoes", contacts: { phone: "+77001112233" } },
  offer_types: [{ key: "shoes", name: "Shoes", kind: "product", attributes: [] }],
  offers: [
    {
      title: "Runner",
      offer_type: "shoes",
      price: 100,
      currency: "KZT",
      price_status: "confirmed",
      availability: "in_stock",
    },
  ],
};

const listBody = { jsonrpc: "2.0", id: 1, method: "tools/list" };

function callBody(name: string, args: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } };
}

async function newStore(options: { live: boolean } = { live: true }) {
  const owner = await createTestTenant({ actor: "owner", live: options.live });
  await services.catalog.applyBusinessModel({ ...owner, actor: "system" }, model);
  const customerKey = await tenancy.createApiKey(owner, "customer_agent");
  const ownerKey = await tenancy.createApiKey(owner, "owner");
  const offers = await services.catalog.searchOffers({ ...owner, actor: "system" }, {});
  return { owner, customerKey: customerKey.key, ownerKey, offerId: offers.items[0]!.id };
}

const auth = (key: string) => ({ authorization: `Bearer ${key}` });
const customerUrl = (slug: string) => `http://localhost/api/mcp/customer/${slug}`;
const BUSINESS_URL = "http://localhost/api/mcp/business";

async function customer(slug: string, body: unknown, headers: Record<string, string> = {}) {
  return handleCustomerMcp(mcpRequest(customerUrl(slug), body, headers), slug, services);
}

async function business(body: unknown, headers: Record<string, string> = {}) {
  return handleBusinessMcp(mcpRequest(BUSINESS_URL, body, headers), services);
}

interface RpcResult {
  result?: { tools?: { name: string }[]; isError?: boolean; content?: { text: string }[] };
  error?: { message: string };
}

async function rpc(response: Response): Promise<RpcResult> {
  return (await response.json()) as RpcResult;
}

/** Text of the first content block of a tools/call response. */
async function toolText(response: Response): Promise<{ isError: boolean; text: string }> {
  const body = await rpc(response);
  return { isError: body.result?.isError === true, text: body.result?.content?.[0]?.text ?? "" };
}

async function ownerSession(tenantId: string) {
  const email = `${uniqueSlug("owner")}@example.com`;
  await tenancy.createOwner(tenantId, { email, password: "correct-horse-battery" });
  const token = await tenancy.signIn({ email, password: "correct-horse-battery" });
  return { cookie: `session=${encodeURIComponent(token!)}` };
}

describe("customer MCP endpoint", () => {
  it("returns 401 without credentials", async () => {
    const store = await newStore();
    const response = await customer(store.owner.slug, listBody);
    expect(response.status).toBe(401);
  });

  it("returns 401 for an unknown key", async () => {
    const store = await newStore();
    const response = await customer(store.owner.slug, listBody, auth("sk_unknown_key"));
    expect(response.status).toBe(401);
  });

  it("returns 401 when an owner key is used as a customer key", async () => {
    const store = await newStore();
    const response = await customer(store.owner.slug, listBody, auth(store.ownerKey.key));
    expect(response.status).toBe(401);
  });

  it("returns 403 when the key belongs to another store", async () => {
    const a = await newStore();
    const b = await newStore();
    const response = await customer(a.owner.slug, listBody, auth(b.customerKey));
    expect(response.status).toBe(403);
  });

  it("returns 404 for an unknown slug", async () => {
    const store = await newStore();
    const response = await customer(uniqueSlug("missing"), listBody, auth(store.customerKey));
    expect(response.status).toBe(404);
  });

  it("returns 404 for a store that is not live", async () => {
    const draft = await newStore({ live: false });
    const response = await customer(draft.owner.slug, listBody, auth(draft.customerKey));
    expect(response.status).toBe(404);
  });

  it("lists the seven customer tools for a valid key on a live store", async () => {
    const store = await newStore();
    const response = await customer(store.owner.slug, listBody, auth(store.customerKey));
    expect(response.status).toBe(200);
    const names = (await rpc(response)).result?.tools?.map((t) => t.name).sort();
    expect(names).toEqual([...CUSTOMER_TOOLS].sort());
    expect(names).toHaveLength(7);
  });

  it("runs search_offers through HTTP", async () => {
    const store = await newStore();
    const response = await customer(
      store.owner.slug,
      callBody("search_offers", { query: "Runner" }),
      auth(store.customerKey),
    );
    expect(response.status).toBe(200);
    const { isError, text } = await toolText(response);
    expect(isError).toBe(false);
    const data = JSON.parse(text) as { total: number; offers: { title: string }[] };
    expect(data.total).toBe(1);
    expect(data.offers[0]?.title).toBe("Runner");
  });

  async function placeOrder(store: Awaited<ReturnType<typeof newStore>>, headers = {}) {
    const response = await customer(
      store.owner.slug,
      callBody("create_order", {
        idempotency_key: `key-${uniqueSlug()}`,
        items: [{ offer_id: store.offerId, quantity: 1 }],
      }),
      { ...auth(store.customerKey), ...headers },
    );
    const { isError, text } = await toolText(response);
    expect(isError).toBe(false);
    return JSON.parse(text) as { order_id: string; source: string };
  }

  it("stores orders from the storefront channel by default", async () => {
    const store = await newStore();
    const order = await placeOrder(store);
    expect(order.source).toBe("storefront");
  });

  it("stores the external_agent channel as the order source", async () => {
    const store = await newStore();
    const order = await placeOrder(store, { "x-storefront-channel": "external_agent" });
    expect(order.source).toBe("external_agent");
    const stored = await services.orders.getOrder(
      { ...store.owner, actor: "owner" },
      order.order_id,
    );
    expect(stored?.source).toBe("external_agent");
  });

  it("returns 400 for an invalid conversation id", async () => {
    const store = await newStore();
    const response = await customer(store.owner.slug, listBody, {
      ...auth(store.customerKey),
      "x-conversation-id": "not-a-uuid",
    });
    expect(response.status).toBe(400);
  });
});

describe("business MCP endpoint", () => {
  async function newDraftId(store: Awaited<ReturnType<typeof newStore>>) {
    const draft = await services.catalog.saveDraft(
      { ...store.owner, actor: "business_agent" },
      model,
    );
    return draft.id;
  }

  it("returns 401 without credentials", async () => {
    const response = await business(listBody);
    expect(response.status).toBe(401);
  });

  it("returns 401 for a customer key", async () => {
    const store = await newStore();
    const response = await business(listBody, auth(store.customerKey));
    expect(response.status).toBe(401);
  });

  it("returns 401 for a revoked owner key", async () => {
    const store = await newStore();
    await tenancy.revokeApiKey(store.owner, store.ownerKey.id);
    const response = await business(listBody, auth(store.ownerKey.key));
    expect(response.status).toBe(401);
  });

  it("returns 401 for a garbage session cookie without a key", async () => {
    const response = await business(listBody, { cookie: "session=garbage" });
    expect(response.status).toBe(401);
  });

  it("accepts a valid owner key and acts as the business agent", async () => {
    const store = await newStore();
    const draftId = await newDraftId(store);
    const list = await business(listBody, auth(store.ownerKey.key));
    expect(list.status).toBe(200);
    expect((await rpc(list)).result?.tools?.length).toBeGreaterThan(0);

    const confirm = await business(
      callBody("confirm_business_model", { draft_id: draftId }),
      auth(store.ownerKey.key),
    );
    const { isError, text } = await toolText(confirm);
    expect(isError).toBe(true);
    expect(text).toMatch(/^forbidden/);
  });

  it("acts as the owner for a valid session cookie", async () => {
    const store = await newStore();
    const draftId = await newDraftId(store);
    const { cookie } = await ownerSession(store.owner.tenantId);

    const confirm = await business(callBody("confirm_business_model", { draft_id: draftId }), {
      cookie,
    });
    expect(confirm.status).toBe(200);
    const { isError, text } = await toolText(confirm);
    expect(isError).toBe(false);
    expect(JSON.parse(text)).toMatchObject({ draft_id: draftId, status: "confirmed" });
  });

  it("falls back to a valid key when the session cookie is invalid", async () => {
    const store = await newStore();
    const response = await business(listBody, {
      ...auth(store.ownerKey.key),
      cookie: "session=garbage",
    });
    expect(response.status).toBe(200);
  });

  it("does not let a session of one tenant read another tenant's data", async () => {
    const a = await newStore();
    const b = await newStore();
    const order = await services.orders.createOrder(
      { ...b.owner, actor: "customer_agent" },
      {
        idempotencyKey: `key-${uniqueSlug()}`,
        items: [{ offerId: b.offerId, quantity: 1 }],
        source: "storefront",
      },
    );
    const { cookie } = await ownerSession(a.owner.tenantId);

    const response = await business(callBody("get_order", { id: order.order.id }), { cookie });
    const { isError, text } = await toolText(response);
    expect(isError).toBe(true);
    expect(text).toMatch(/^not_found/);

    const mine = await business(callBody("get_business_model"), { cookie });
    const profile = JSON.parse((await toolText(mine)).text) as { offers: { offer_id: string }[] };
    expect(profile.offers.map((o) => o.offer_id)).not.toContain(b.offerId);
  });
});
