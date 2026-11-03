import { describe, expect, it } from "vitest";
import { EVENTS } from "@/server/events/types";
import { createApprovalsService } from "@/server/services/approvals";
import { createAuditService } from "@/server/services/audit";
import { createCatalogService } from "@/server/services/catalog";
import { ServiceError, type TenantContext } from "@/server/services/context";
import type { BusinessModelInput } from "@/shared/business-model";
import { createTestTenant, recordingEvents, testDb } from "../helpers/db";

const model: BusinessModelInput = {
  profile: { name: "Shop" },
  offer_types: [
    {
      key: "item",
      name: "Item",
      kind: "product",
      attributes: [{ key: "color", label: "Color", type: "text", required: false }],
    },
  ],
  offers: [
    {
      title: "Alpha",
      offer_type: "item",
      price: 100,
      currency: "KZT",
      price_status: "confirmed",
      availability: "in_stock",
    },
    {
      title: "Beta",
      offer_type: "item",
      price: 200,
      currency: "KZT",
      price_status: "confirmed",
      availability: "in_stock",
    },
    {
      title: "Gamma",
      offer_type: "item",
      price: 300,
      currency: "KZT",
      price_status: "confirmed",
      availability: "in_stock",
    },
  ],
};

const MISSING = "00000000-0000-4000-8000-000000000000";

async function setup() {
  const db = testDb();
  const events = recordingEvents();
  const owner = await createTestTenant({ actor: "owner" });
  const agent: TenantContext = { tenantId: owner.tenantId, actor: "business_agent" };
  const catalog = createCatalogService({ db, events });
  await catalog.applyBusinessModel(owner, model);
  const { items } = await catalog.searchOffers(owner, { limit: 100 });
  const ids = Object.fromEntries(items.map((o) => [o.title, o.id])) as Record<string, string>;
  return {
    owner,
    agent,
    catalog,
    ids,
    events,
    approvals: createApprovalsService(db, events),
    audit: createAuditService(db),
  };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ServiceError);
  expect((error as ServiceError).code).toBe(code);
}

describe("createChangeSet", () => {
  it("publishes an event for agent change sets and not for owner ones", async () => {
    const { owner, agent, approvals, events, ids } = await setup();
    const ops = [{ op: "update_prices" as const, items: [{ offerId: ids["Alpha"]!, price: 100 }] }];
    const byAgent = await approvals.createChangeSet(agent, { ops });
    expect(events.ofType(EVENTS.changeSetCreated)).toEqual([
      { tenantId: owner.tenantId, changeSetId: byAgent.id },
    ]);
    await approvals.createChangeSet(owner, { ops });
    expect(events.ofType(EVENTS.changeSetCreated)).toHaveLength(1);
  });

  it("stores ops as pending with requestedBy = actor and audits it", async () => {
    const { approvals, agent, ids, audit } = await setup();
    const ops = [{ op: "update_prices" as const, items: [{ offerId: ids.Alpha!, price: 150 }] }];
    const cs = await approvals.createChangeSet(agent, { ops, reason: "sale" });
    expect(cs.status).toBe("pending");
    expect(cs.requestedBy).toBe("business_agent");
    expect(cs.reason).toBe("sale");
    expect(cs.resolvedAt).toBeNull();
    expect(cs.ops).toEqual(ops);
    const logged = await audit.list(agent, { entity: "change_set", entityId: cs.id });
    expect(logged.map((e) => e.action)).toEqual(["change_set.created"]);
  });

  it("rejects invalid ops", async () => {
    const { approvals, agent, ids } = await setup();
    await expectCode(
      approvals.createChangeSet(agent, { ops: [{ op: "drop_tables" } as never] }),
      "invalid",
    );
    await expectCode(
      approvals.createChangeSet(agent, { ops: [{ op: "update_prices", items: [] }] }),
      "invalid",
    );
    await expectCode(
      approvals.createChangeSet(agent, { ops: [{ op: "delete_offers", offerIds: ["nope"] }] }),
      "invalid",
    );
    await expectCode(approvals.createChangeSet(agent, { ops: [] }), "invalid");
    expect(await approvals.listChangeSets(agent)).toHaveLength(0);
    void ids;
  });
});

describe("approveChangeSet", () => {
  it("is forbidden for non-owners and applies nothing", async () => {
    const { approvals, agent, catalog, ids, owner } = await setup();
    const cs = await approvals.createChangeSet(agent, {
      ops: [{ op: "update_prices", items: [{ offerId: ids.Alpha!, price: 1 }] }],
    });
    await expectCode(approvals.approveChangeSet(agent, cs.id), "forbidden");
    expect((await catalog.getOffer(owner, ids.Alpha!))?.price).toBe(100);
    expect((await approvals.getChangeSet(owner, cs.id))?.status).toBe("pending");
  });

  it("applies update_prices, delete_offers and upsert_offers", async () => {
    const { approvals, agent, owner, catalog, ids, audit } = await setup();
    const cs = await approvals.createChangeSet(agent, {
      ops: [
        {
          op: "update_prices",
          items: [
            { offerId: ids.Alpha!, price: 111 },
            { offerId: ids.Beta!, price: null },
          ],
        },
        { op: "delete_offers", offerIds: [ids.Gamma!] },
        {
          op: "upsert_offers",
          offers: [
            {
              title: "Delta",
              offer_type: "item",
              price: 400,
              currency: "KZT",
              price_status: "confirmed",
              availability: "in_stock",
            },
          ],
        },
      ],
    });
    const applied = await approvals.approveChangeSet(owner, cs.id);
    expect(applied.status).toBe("applied");
    expect(applied.resolvedAt).toBeInstanceOf(Date);

    const alpha = await catalog.getOffer(owner, ids.Alpha!);
    expect(alpha?.price).toBe(111);
    expect(alpha?.priceStatus).toBe("confirmed");
    const beta = await catalog.getOffer(owner, ids.Beta!);
    expect(beta?.price).toBeNull();
    expect(beta?.priceStatus).toBe("on_request");
    expect((await catalog.getOffer(owner, ids.Gamma!))?.status).toBe("archived");
    const delta = await catalog.searchOffers(owner, { query: "Delta" });
    expect(delta.items).toHaveLength(1);
    expect(delta.items[0]?.price).toBe(400);

    const actions = (await audit.list(owner, { limit: 500 })).map((e) => e.action);
    expect(actions).toContain("change_set.applied");
    expect(actions).toContain("offer.price_updated");
    expect(actions).toContain("offer.archived");
    expect(actions).toContain("offer.created");
  });

  it("is atomic: a failing second op rolls back the first", async () => {
    const { approvals, agent, owner, catalog, ids, audit } = await setup();
    const cs = await approvals.createChangeSet(agent, {
      ops: [
        { op: "update_prices", items: [{ offerId: ids.Alpha!, price: 999 }] },
        { op: "update_prices", items: [{ offerId: MISSING, price: 1 }] },
      ],
    });
    await expectCode(approvals.approveChangeSet(owner, cs.id), "not_found");
    expect((await catalog.getOffer(owner, ids.Alpha!))?.price).toBe(100);
    expect((await approvals.getChangeSet(owner, cs.id))?.status).toBe("pending");
    const actions = (await audit.list(owner, { limit: 500 })).map((e) => e.action);
    expect(actions).not.toContain("change_set.applied");
    expect(actions).not.toContain("offer.price_updated");
  });

  it("conflicts when approving or rejecting a resolved set", async () => {
    const { approvals, agent, owner, ids } = await setup();
    const mk = () =>
      approvals.createChangeSet(agent, {
        ops: [{ op: "update_prices", items: [{ offerId: ids.Alpha!, price: 5 }] }],
      });
    const applied = await mk();
    await approvals.approveChangeSet(owner, applied.id);
    await expectCode(approvals.approveChangeSet(owner, applied.id), "conflict");
    await expectCode(approvals.rejectChangeSet(owner, applied.id), "conflict");

    const rejected = await mk();
    await approvals.rejectChangeSet(owner, rejected.id);
    await expectCode(approvals.approveChangeSet(owner, rejected.id), "conflict");
    await expectCode(approvals.rejectChangeSet(owner, rejected.id), "conflict");
  });
});

describe("rejectChangeSet", () => {
  it("works for the owner without applying and audits", async () => {
    const { approvals, agent, owner, catalog, ids, audit } = await setup();
    const cs = await approvals.createChangeSet(agent, {
      ops: [{ op: "delete_offers", offerIds: [ids.Alpha!] }],
    });
    const rejected = await approvals.rejectChangeSet(owner, cs.id);
    expect(rejected.status).toBe("rejected");
    expect(rejected.resolvedAt).toBeInstanceOf(Date);
    expect((await catalog.getOffer(owner, ids.Alpha!))?.status).toBe("active");
    const logged = await audit.list(owner, { entity: "change_set", entityId: cs.id });
    expect(logged.map((e) => e.action)).toContain("change_set.rejected");
  });

  it("is forbidden for non-owners", async () => {
    const { approvals, agent, ids } = await setup();
    const cs = await approvals.createChangeSet(agent, {
      ops: [{ op: "delete_offers", offerIds: [ids.Alpha!] }],
    });
    await expectCode(approvals.rejectChangeSet(agent, cs.id), "forbidden");
    expect((await approvals.getChangeSet(agent, cs.id))?.status).toBe("pending");
  });
});

describe("listChangeSets", () => {
  it("filters by status", async () => {
    const { approvals, agent, owner, ids } = await setup();
    const mk = () =>
      approvals.createChangeSet(agent, {
        ops: [{ op: "update_prices", items: [{ offerId: ids.Alpha!, price: 7 }] }],
      });
    const a = await mk();
    const b = await mk();
    const c = await mk();
    await approvals.approveChangeSet(owner, a.id);
    await approvals.rejectChangeSet(owner, b.id);

    expect((await approvals.listChangeSets(owner)).map((x) => x.id).sort()).toEqual(
      [a.id, b.id, c.id].sort(),
    );
    expect((await approvals.listChangeSets(owner, { status: "pending" })).map((x) => x.id)).toEqual(
      [c.id],
    );
    expect((await approvals.listChangeSets(owner, { status: "applied" })).map((x) => x.id)).toEqual(
      [a.id],
    );
    expect(
      (await approvals.listChangeSets(owner, { status: "rejected" })).map((x) => x.id),
    ).toEqual([b.id]);
  });
});

describe("tenant isolation", () => {
  it("hides A's change sets from B", async () => {
    const a = await setup();
    const b = await setup();
    const cs = await a.approvals.createChangeSet(a.agent, {
      ops: [{ op: "update_prices", items: [{ offerId: a.ids.Alpha!, price: 1 }] }],
    });
    expect(await b.approvals.getChangeSet(b.owner, cs.id)).toBeNull();
    await expectCode(b.approvals.approveChangeSet(b.owner, cs.id), "not_found");
    await expectCode(b.approvals.rejectChangeSet(b.owner, cs.id), "not_found");
    expect((await b.approvals.listChangeSets(b.owner)).map((x) => x.id)).not.toContain(cs.id);
    expect((await a.approvals.getChangeSet(a.owner, cs.id))?.status).toBe("pending");
  });

  it("does not let B's change set touch A's offers", async () => {
    const a = await setup();
    const b = await setup();
    const cs = await b.approvals.createChangeSet(b.agent, {
      ops: [
        { op: "update_prices", items: [{ offerId: a.ids.Alpha!, price: 1 }] },
        { op: "delete_offers", offerIds: [a.ids.Beta!] },
      ],
    });
    await expectCode(b.approvals.approveChangeSet(b.owner, cs.id), "not_found");
    expect((await a.catalog.getOffer(a.owner, a.ids.Alpha!))?.price).toBe(100);
    expect((await a.catalog.getOffer(a.owner, a.ids.Beta!))?.status).toBe("active");
    expect((await b.approvals.getChangeSet(b.owner, cs.id))?.status).toBe("pending");

    const del = await b.approvals.createChangeSet(b.agent, {
      ops: [{ op: "delete_offers", offerIds: [a.ids.Beta!] }],
    });
    await expectCode(b.approvals.approveChangeSet(b.owner, del.id), "not_found");
    expect((await a.catalog.getOffer(a.owner, a.ids.Beta!))?.status).toBe("active");
  });
});
