import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentConfigs, auditEvents, businessModelDrafts, tenants } from "@/db/schema";
import { barbershopModel } from "@/db/seed-data/barbershop";
import { handlers } from "@/server/events/handlers";
import { EVENTS } from "@/server/events/types";
import { createCatalogService } from "@/server/services/catalog";
import { ServiceError, type TenantContext } from "@/server/services/context";
import { createProvisioningService } from "@/server/services/provisioning";
import type { BusinessModelInput } from "@/shared/business-model";
import { createTestTenant, recordingEvents, testDb, testTenancy } from "../helpers/db";

const DEFAULT_MODEL = "test-model-1";

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ServiceError);
  expect((error as ServiceError).code).toBe(code);
  return error as ServiceError;
}

function setup() {
  const events = recordingEvents();
  const db = testDb();
  const catalog = createCatalogService({ db, events });
  const provisioning = createProvisioningService({ db, events, defaultModel: DEFAULT_MODEL });
  return { events, catalog, provisioning };
}

const minimalModel = (
  overrides: Partial<BusinessModelInput["profile"]> = {},
): BusinessModelInput => ({
  profile: {
    name: "Corner Shop",
    description: "Neighbourhood store",
    contacts: { phone: "+77001112233" },
    ...overrides,
  },
});

function modelWith(title: string): BusinessModelInput {
  return {
    profile: { name: "Shoe Shop", description: "Shoes", contacts: { email: "a@b.co" } },
    offer_types: [{ key: "shoe", name: "Shoe", kind: "product", attributes: [] }],
    offers: [
      {
        title,
        offer_type: "shoe",
        price: 100,
        currency: "USD",
        price_status: "confirmed",
        availability: "in_stock",
      },
    ],
  };
}

const activeBarbershopOffers = () => barbershopModel.offers!.filter((o) => o.status !== "draft");

async function confirmed(model: BusinessModelInput, tenant?: TenantContext & { slug: string }) {
  const s = setup();
  const t = tenant ?? (await createTestTenant());
  const draft = await s.catalog.saveDraft(t, model);
  await s.catalog.confirmDraft(t, draft.id);
  return { ...s, tenant: t, draftId: draft.id };
}

async function auditActions(tenantId: string) {
  const rows = await testDb().select().from(auditEvents).where(eq(auditEvents.tenantId, tenantId));
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.action] = (counts[row.action] ?? 0) + 1;
  return counts;
}

async function tenantStatus(tenantId: string) {
  const [row] = await testDb().select().from(tenants).where(eq(tenants.id, tenantId));
  return row!.status;
}

function configsOf(tenantId: string) {
  return testDb().select().from(agentConfigs).where(eq(agentConfigs.tenantId, tenantId));
}

describe("confirmDraft launch readiness", () => {
  it("refuses a draft without any contact channel", async () => {
    const { catalog } = setup();
    const tenant = await createTestTenant();
    const draft = await catalog.saveDraft(tenant, minimalModel({ contacts: {} }));
    const error = await expectCode(catalog.confirmDraft(tenant, draft.id), "invalid");
    expect(error.message).toContain("contact channel");
    expect(await catalog.getLatestDraft(tenant)).toMatchObject({ status: "draft" });
  });

  it("does not count an address as a contact channel", async () => {
    const { catalog, events } = setup();
    const tenant = await createTestTenant();
    const draft = await catalog.saveDraft(
      tenant,
      minimalModel({ contacts: { address: "1 Main St" } }),
    );
    await expectCode(catalog.confirmDraft(tenant, draft.id), "invalid");
    expect(events.ofType(EVENTS.modelConfirmed)).toHaveLength(0);
  });

  it("refuses a model with no description and no active offer", async () => {
    const { catalog } = setup();
    const tenant = await createTestTenant();
    const draft = await catalog.saveDraft(tenant, minimalModel({ description: "" }));
    const error = await expectCode(catalog.confirmDraft(tenant, draft.id), "invalid");
    expect(error.message).toContain("description");
  });

  it("accepts a minimal model with name, description and a phone and no offers", async () => {
    const { catalog, events } = setup();
    const tenant = await createTestTenant();
    const draft = await catalog.saveDraft(tenant, minimalModel());
    const result = await catalog.confirmDraft(tenant, draft.id);
    expect(result.status).toBe("confirmed");
    expect(events.ofType(EVENTS.modelConfirmed)).toEqual([
      { tenantId: tenant.tenantId, draftId: draft.id },
    ]);
  });
});

describe("provisioning", () => {
  it("launches a draft tenant from the confirmed model", async () => {
    const { catalog, provisioning, events, tenant, draftId } = await confirmed(barbershopModel);

    const outcome = await provisioning.provision({ tenantId: tenant.tenantId, draftId });
    expect(outcome).toEqual({
      status: "provisioned",
      slug: tenant.slug,
      offers: barbershopModel.offers!.length,
    });

    expect(await tenantStatus(tenant.tenantId)).toBe("live");

    const active = await catalog.searchOffers(tenant, { limit: 100 });
    expect(active.total).toBe(activeBarbershopOffers().length);
    expect(active.total).toBeGreaterThan(0);

    const configs = await configsOf(tenant.tenantId);
    expect(configs.map((c) => c.agent).sort()).toEqual(["business", "customer"]);
    expect(configs.every((c) => c.model === DEFAULT_MODEL)).toBe(true);

    const [draft] = await testDb()
      .select()
      .from(businessModelDrafts)
      .where(eq(businessModelDrafts.id, draftId));
    expect(draft!.appliedAt).toBeInstanceOf(Date);

    const actions = await auditActions(tenant.tenantId);
    expect(actions["tenant.provisioned"]).toBe(1);
    expect(actions["tenant.status_changed"]).toBe(1);
    expect(events.ofType(EVENTS.tenantLive)).toEqual([{ tenantId: tenant.tenantId }]);
  });

  it("does nothing the second time", async () => {
    const { catalog, provisioning, events, tenant, draftId } = await confirmed(barbershopModel);
    const input = { tenantId: tenant.tenantId, draftId };
    await provisioning.provision(input);
    const idsBefore = (await catalog.searchOffers(tenant, { limit: 100 })).items.map((o) => o.id);
    const actionsBefore = await auditActions(tenant.tenantId);

    expect(await provisioning.provision(input)).toEqual({
      status: "already_applied",
      slug: tenant.slug,
    });

    const idsAfter = (await catalog.searchOffers(tenant, { limit: 100 })).items.map((o) => o.id);
    expect(idsAfter).toEqual(idsBefore);
    expect(await auditActions(tenant.tenantId)).toEqual(actionsBefore);
    expect(events.ofType(EVENTS.tenantLive)).toHaveLength(1);
    expect(await configsOf(tenant.tenantId)).toHaveLength(2);
  });

  it("provisions once when called concurrently", async () => {
    const { catalog, provisioning, events, tenant, draftId } = await confirmed(barbershopModel);
    const input = { tenantId: tenant.tenantId, draftId };

    const results = await Promise.all([
      provisioning.provision(input),
      provisioning.provision(input),
      provisioning.provision(input),
    ]);

    expect(results.filter((r) => r.status === "provisioned")).toHaveLength(1);
    expect(results.filter((r) => r.status === "already_applied")).toHaveLength(2);
    expect((await catalog.searchOffers(tenant, { limit: 100 })).total).toBe(
      activeBarbershopOffers().length,
    );
    expect(events.ofType(EVENTS.tenantLive)).toHaveLength(1);
    expect((await auditActions(tenant.tenantId))["tenant.provisioned"]).toBe(1);
  });

  it("refuses a draft that is not confirmed", async () => {
    const { catalog, provisioning } = setup();
    const tenant = await createTestTenant();
    const draft = await catalog.saveDraft(tenant, modelWith("Boot"));

    await expectCode(
      provisioning.provision({ tenantId: tenant.tenantId, draftId: draft.id }),
      "conflict",
    );
    expect(await tenantStatus(tenant.tenantId)).toBe("draft");
    expect((await catalog.searchOffers(tenant)).total).toBe(0);
    expect(await auditActions(tenant.tenantId)).not.toHaveProperty("tenant.provisioned");
  });

  it("refuses a rejected draft", async () => {
    const { catalog, provisioning } = setup();
    const tenant = await createTestTenant();
    const old = await catalog.saveDraft(tenant, modelWith("Boot"));
    await catalog.saveDraft(tenant, modelWith("Sandal"));

    await expectCode(
      provisioning.provision({ tenantId: tenant.tenantId, draftId: old.id }),
      "conflict",
    );
    expect(await tenantStatus(tenant.tenantId)).toBe("draft");
    expect((await catalog.searchOffers(tenant)).total).toBe(0);
  });

  it("reports not_found for an unknown draft id", async () => {
    const { provisioning } = setup();
    const tenant = await createTestTenant();
    await expectCode(
      provisioning.provision({
        tenantId: tenant.tenantId,
        draftId: "00000000-0000-4000-8000-000000000000",
      }),
      "not_found",
    );
    expect(await tenantStatus(tenant.tenantId)).toBe("draft");
  });

  it("does not provision a draft through another tenant", async () => {
    const { catalog, provisioning, tenant, draftId } = await confirmed(modelWith("Boot"));
    const other = await createTestTenant();

    await expectCode(provisioning.provision({ tenantId: other.tenantId, draftId }), "not_found");

    expect(await tenantStatus(other.tenantId)).toBe("draft");
    expect(await tenantStatus(tenant.tenantId)).toBe("draft");
    expect((await catalog.searchOffers(other)).total).toBe(0);
    expect((await catalog.searchOffers(tenant)).total).toBe(0);
    expect(await auditActions(other.tenantId)).not.toHaveProperty("tenant.provisioned");
  });

  it("replaces the catalog of a tenant that is already live", async () => {
    const tenant = await createTestTenant({ live: true });
    const first = await confirmed(modelWith("Boot"), tenant);
    await first.provisioning.provision({ tenantId: tenant.tenantId, draftId: first.draftId });
    const before = await auditActions(tenant.tenantId);

    const second = await confirmed(modelWith("Sandal"), tenant);
    const outcome = await second.provisioning.provision({
      tenantId: tenant.tenantId,
      draftId: second.draftId,
    });
    expect(outcome.status).toBe("provisioned");

    const active = await second.catalog.searchOffers(tenant);
    expect(active.items.map((o) => o.title)).toEqual(["Sandal"]);
    const archived = await second.catalog.searchOffers(tenant, { statuses: ["archived"] });
    expect(archived.items.map((o) => o.title)).toEqual(["Boot"]);

    const after = await auditActions(tenant.tenantId);
    expect(after["tenant.status_changed"]).toBe(before["tenant.status_changed"]);
    expect(after["tenant.provisioned"]).toBe(2);
    expect(await configsOf(tenant.tenantId)).toHaveLength(2);
  });
});

describe("model.confirmed handler", () => {
  it("provisions the tenant", async () => {
    const { provisioning, tenant, draftId } = await confirmed(modelWith("Boot"));
    const logs: string[] = [];

    await handlers[EVENTS.modelConfirmed](
      { tenantId: tenant.tenantId, draftId },
      { db: testDb(), provisioning, log: (m) => logs.push(m) },
    );

    expect(await tenantStatus(tenant.tenantId)).toBe("live");
    expect(logs.join("\n")).toContain(`/s/${tenant.slug}`);
  });

  it("is safe to run again", async () => {
    const { provisioning, events, tenant, draftId } = await confirmed(modelWith("Boot"));
    const payload = { tenantId: tenant.tenantId, draftId };
    const deps = { db: testDb(), provisioning };
    await handlers[EVENTS.modelConfirmed](payload, deps);
    await handlers[EVENTS.modelConfirmed](payload, deps);
    expect(events.ofType(EVENTS.tenantLive)).toHaveLength(1);
  });

  it("throws a clear error when provisioning is not passed", async () => {
    const { tenant, draftId } = await confirmed(modelWith("Boot"));
    await expect(
      handlers[EVENTS.modelConfirmed]({ tenantId: tenant.tenantId, draftId }, { db: testDb() }),
    ).rejects.toThrow(/provisioning is not configured/);
    expect(await tenantStatus(tenant.tenantId)).toBe("draft");
  });
});

describe("owner flow", () => {
  it("goes from a saved draft to a reachable store", async () => {
    const { catalog, provisioning, events } = setup();
    const tenancy = testTenancy();
    const tenant = await createTestTenant();

    expect(await tenancy.contextFromSlug(tenant.slug, "customer_agent")).toBeNull();

    const draft = await catalog.saveDraft(tenant, barbershopModel);
    await catalog.confirmDraft(tenant, draft.id);

    const [payload] = events.ofType(EVENTS.modelConfirmed);
    expect(payload).toEqual({ tenantId: tenant.tenantId, draftId: draft.id });
    await handlers[EVENTS.modelConfirmed](payload!, { db: testDb(), provisioning });

    const ctx = await tenancy.contextFromSlug(tenant.slug, "customer_agent");
    expect(ctx).toEqual({ tenantId: tenant.tenantId, actor: "customer_agent" });
    expect((await catalog.searchOffers(ctx!)).total).toBeGreaterThan(0);
  });
});
