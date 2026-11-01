import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ServiceError } from "@/server/services/context";
import { signSession } from "@/server/services/tenancy";
import { createTestTenant, TEST_AUTH_SECRET, testTenancy, uniqueSlug } from "../helpers/db";

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ServiceError);
  expect((error as ServiceError).code).toBe(code);
}

const hex = () => randomBytes(4).toString("hex");
const email = () => `owner-${hex()}@example.com`;

async function ownerFixture() {
  const tenancy = testTenancy();
  const tenant = await tenancy.createTenant({ name: "Fixture", slug: uniqueSlug() });
  const address = email();
  const { userId } = await tenancy.createOwner(tenant.id, {
    email: address,
    password: "correct-horse",
  });
  return { tenancy, tenant, address, userId };
}

describe("createTenant", () => {
  it("generates a slug from a Latin name", async () => {
    const token = hex();
    const tenant = await testTenancy().createTenant({ name: `Acme ${token}` });
    expect(tenant.slug).toBe(`acme-${token}`);
    expect(tenant.status).toBe("draft");
  });

  it("falls back to a store-xxxxxx slug for non-Latin names", async () => {
    const tenant = await testTenancy().createTenant({ name: "Обувь" });
    expect(tenant.slug).toMatch(/^store-[0-9a-f]{6}$/);
  });

  it("rejects an explicit slug that is taken", async () => {
    const slug = uniqueSlug();
    const tenancy = testTenancy();
    await tenancy.createTenant({ name: "One", slug });
    await expectCode(tenancy.createTenant({ name: "Two", slug }), "conflict");
  });

  it("rejects an invalid explicit slug", async () => {
    const tenancy = testTenancy();
    await expectCode(tenancy.createTenant({ name: "X", slug: "Bad Slug" }), "invalid");
    await expectCode(tenancy.createTenant({ name: "X", slug: "ab" }), "invalid");
    await expectCode(tenancy.createTenant({ name: "X", slug: "-abc" }), "invalid");
  });

  it("rejects an empty name", async () => {
    await expectCode(testTenancy().createTenant({ name: "   " }), "invalid");
  });
});

describe("owners and sessions", () => {
  it("signs in an owner and resolves an owner context", async () => {
    const { tenancy, tenant, address, userId } = await ownerFixture();
    const token = await tenancy.signIn({ email: address, password: "correct-horse" });
    expect(token).toEqual(expect.any(String));
    const ctx = await tenancy.contextFromSession(token!);
    expect(ctx).toEqual({ tenantId: tenant.id, actor: "owner", userId });
  });

  it("normalizes email case on sign-in", async () => {
    const { tenancy, address } = await ownerFixture();
    const token = await tenancy.signIn({ email: address.toUpperCase(), password: "correct-horse" });
    expect(token).not.toBeNull();
  });

  it("returns null for a wrong password", async () => {
    const { tenancy, address } = await ownerFixture();
    expect(await tenancy.signIn({ email: address, password: "wrong-password" })).toBeNull();
  });

  it("returns null for an unknown email", async () => {
    expect(await testTenancy().signIn({ email: email(), password: "whatever-123" })).toBeNull();
  });

  it("rejects a duplicate email", async () => {
    const { tenancy, address } = await ownerFixture();
    const other = await tenancy.createTenant({ name: "Other", slug: uniqueSlug() });
    await expectCode(
      tenancy.createOwner(other.id, { email: address.toUpperCase(), password: "correct-horse" }),
      "conflict",
    );
  });

  it("rejects a short password and a malformed email", async () => {
    const tenancy = testTenancy();
    const tenant = await tenancy.createTenant({ name: "T", slug: uniqueSlug() });
    await expectCode(
      tenancy.createOwner(tenant.id, { email: email(), password: "short" }),
      "invalid",
    );
    await expectCode(
      tenancy.createOwner(tenant.id, { email: "nope", password: "long-enough-1" }),
      "invalid",
    );
  });

  it("rejects a token with a tampered payload", async () => {
    const { tenancy, address } = await ownerFixture();
    const token = (await tenancy.signIn({ email: address, password: "correct-horse" }))!;
    const [payload, signature] = token.split(".") as [string, string];
    const swapped = (payload[0] === "A" ? "B" : "A") + payload.slice(1);
    expect(await tenancy.contextFromSession(`${swapped}.${signature}`)).toBeNull();
  });

  it("rejects a token with a tampered signature", async () => {
    const { tenancy, address } = await ownerFixture();
    const token = (await tenancy.signIn({ email: address, password: "correct-horse" }))!;
    const [payload, signature] = token.split(".") as [string, string];
    const swapped = signature.slice(0, 5) + (signature[5] === "A" ? "B" : "A") + signature.slice(6);
    expect(await tenancy.contextFromSession(`${payload}.${swapped}`)).toBeNull();
    expect(await tenancy.contextFromSession(`${payload}.${signature}.x`)).toBeNull();
    expect(await tenancy.contextFromSession("garbage")).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const { tenancy, tenant, userId } = await ownerFixture();
    const forged = signSession(
      { userId, tenantId: tenant.id, exp: Math.floor(Date.now() / 1000) + 3600 },
      "another-secret-of-sufficient-length",
    );
    expect(await tenancy.contextFromSession(forged)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const { tenancy, tenant, userId } = await ownerFixture();
    const expired = signSession(
      { userId, tenantId: tenant.id, exp: Math.floor(Date.now() / 1000) - 10 },
      TEST_AUTH_SECRET,
    );
    expect(await tenancy.contextFromSession(expired)).toBeNull();
    const valid = signSession(
      { userId, tenantId: tenant.id, exp: Math.floor(Date.now() / 1000) + 600 },
      TEST_AUTH_SECRET,
    );
    expect(await tenancy.contextFromSession(valid)).not.toBeNull();
  });

  it("rejects a validly signed token that points a user at another tenant", async () => {
    const a = await ownerFixture();
    const b = await ownerFixture();
    const forged = signSession(
      { userId: a.userId, tenantId: b.tenant.id, exp: Math.floor(Date.now() / 1000) + 3600 },
      TEST_AUTH_SECRET,
    );
    expect(await a.tenancy.contextFromSession(forged)).toBeNull();
  });
});

describe("API keys", () => {
  it("resolves an owner key with the actor chosen by the caller", async () => {
    const owner = await createTestTenant({ actor: "owner" });
    const tenancy = testTenancy();
    const created = await tenancy.createApiKey(owner, "owner");
    expect(created.key.startsWith("sk_own_")).toBe(true);
    const ctx = await tenancy.contextFromApiKey(created.key, "owner", "business_agent");
    expect(ctx).toEqual({ tenantId: owner.tenantId, actor: "business_agent" });
  });

  it("returns null for the wrong kind or an unknown key", async () => {
    const owner = await createTestTenant({ actor: "owner" });
    const tenancy = testTenancy();
    const created = await tenancy.createApiKey(owner, "owner");
    expect(
      await tenancy.contextFromApiKey(created.key, "customer_agent", "customer_agent"),
    ).toBeNull();
    expect(await tenancy.contextFromApiKey("sk_own_nonexistent", "owner", "owner")).toBeNull();
  });

  it("resolves a customer_agent key created by a non-owner", async () => {
    const agent = await createTestTenant({ actor: "business_agent" });
    const tenancy = testTenancy();
    const created = await tenancy.createApiKey(agent, "customer_agent");
    const ctx = await tenancy.contextFromApiKey(created.key, "customer_agent", "customer_agent");
    expect(ctx).toEqual({ tenantId: agent.tenantId, actor: "customer_agent" });
  });

  it("returns null once revoked", async () => {
    const owner = await createTestTenant({ actor: "owner" });
    const tenancy = testTenancy();
    const created = await tenancy.createApiKey(owner, "owner");
    await tenancy.revokeApiKey(owner, created.id);
    expect(await tenancy.contextFromApiKey(created.key, "owner", "owner")).toBeNull();
  });

  it("forbids creating an owner key from a non-owner context", async () => {
    const agent = await createTestTenant({ actor: "business_agent" });
    await expectCode(testTenancy().createApiKey(agent, "owner"), "forbidden");
  });

  it("forbids revoking from a non-owner context", async () => {
    const owner = await createTestTenant({ actor: "owner" });
    const tenancy = testTenancy();
    const created = await tenancy.createApiKey(owner, "owner");
    await expectCode(
      tenancy.revokeApiKey({ ...owner, actor: "customer_agent" }, created.id),
      "forbidden",
    );
    expect(await tenancy.contextFromApiKey(created.key, "owner", "owner")).not.toBeNull();
  });

  it("cannot be revoked by another tenant, and keeps working", async () => {
    const a = await createTestTenant({ actor: "owner" });
    const b = await createTestTenant({ actor: "owner" });
    const tenancy = testTenancy();
    const created = await tenancy.createApiKey(a, "owner");
    await expectCode(tenancy.revokeApiKey(b, created.id), "not_found");
    expect(await tenancy.contextFromApiKey(created.key, "owner", "owner")).toEqual({
      tenantId: a.tenantId,
      actor: "owner",
    });
  });

  it("revoking twice reports not_found", async () => {
    const owner = await createTestTenant({ actor: "owner" });
    const tenancy = testTenancy();
    const created = await tenancy.createApiKey(owner, "owner");
    await tenancy.revokeApiKey(owner, created.id);
    await expectCode(tenancy.revokeApiKey(owner, created.id), "not_found");
  });
});

describe("contextFromSlug", () => {
  it("returns null for a draft tenant unless allowDraft is set", async () => {
    const draft = await createTestTenant();
    const tenancy = testTenancy();
    expect(await tenancy.contextFromSlug(draft.slug, "customer_agent")).toBeNull();
    expect(
      await tenancy.contextFromSlug(draft.slug, "customer_agent", { allowDraft: true }),
    ).toEqual({
      tenantId: draft.tenantId,
      actor: "customer_agent",
    });
  });

  it("resolves a live tenant", async () => {
    const live = await createTestTenant({ live: true });
    expect(await testTenancy().contextFromSlug(live.slug, "customer_agent")).toEqual({
      tenantId: live.tenantId,
      actor: "customer_agent",
    });
  });

  it("is case-insensitive", async () => {
    const live = await createTestTenant({ live: true });
    const ctx = await testTenancy().contextFromSlug(live.slug.toUpperCase(), "customer_agent");
    expect(ctx?.tenantId).toBe(live.tenantId);
  });

  it("returns null for an unknown slug", async () => {
    expect(await testTenancy().contextFromSlug(uniqueSlug("nope"), "customer_agent")).toBeNull();
  });
});
