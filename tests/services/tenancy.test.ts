import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditEvents, tenants } from "@/db/schema";
import { ServiceError } from "@/server/services/context";
import { signSession } from "@/server/services/tenancy";
import { createTestTenant, TEST_AUTH_SECRET, testDb, testTenancy, uniqueSlug } from "../helpers/db";

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
    expect(ctx).toEqual({ tenantId: tenant.id, actor: "owner", userId, role: "owner" });
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
      { userId, tenantId: tenant.id, version: 1, exp: Math.floor(Date.now() / 1000) + 3600 },
      "another-secret-of-sufficient-length",
    );
    expect(await tenancy.contextFromSession(forged)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const { tenancy, tenant, userId } = await ownerFixture();
    const expired = signSession(
      { userId, tenantId: tenant.id, version: 1, exp: Math.floor(Date.now() / 1000) - 10 },
      TEST_AUTH_SECRET,
    );
    expect(await tenancy.contextFromSession(expired)).toBeNull();
    const valid = signSession(
      { userId, tenantId: tenant.id, version: 1, exp: Math.floor(Date.now() / 1000) + 600 },
      TEST_AUTH_SECRET,
    );
    expect(await tenancy.contextFromSession(valid)).not.toBeNull();
  });

  it("rejects a signed token without a version claim", async () => {
    const { tenancy, tenant, userId } = await ownerFixture();
    const legacy = signSession(
      { userId, tenantId: tenant.id, exp: Math.floor(Date.now() / 1000) + 3600 } as never,
      TEST_AUTH_SECRET,
    );
    expect(await tenancy.contextFromSession(legacy)).toBeNull();
  });

  it("revokes existing tokens of the user only", async () => {
    const { tenancy, address, userId } = await ownerFixture();
    const other = await ownerFixture();
    const token = (await tenancy.signIn({ email: address, password: "correct-horse" }))!;
    const otherToken = (await other.tenancy.signIn({
      email: other.address,
      password: "correct-horse",
    }))!;
    const ctx = (await tenancy.contextFromSession(token))!;
    expect(ctx.userId).toBe(userId);

    await tenancy.revokeSessions(ctx);

    expect(await tenancy.contextFromSession(token)).toBeNull();
    expect(await other.tenancy.contextFromSession(otherToken)).not.toBeNull();
    const fresh = (await tenancy.signIn({ email: address, password: "correct-horse" }))!;
    expect(await tenancy.contextFromSession(fresh)).not.toBeNull();
  });

  describe("changePassword", () => {
    async function signedIn() {
      const f = await ownerFixture();
      const token = (await f.tenancy.signIn({ email: f.address, password: "correct-horse" }))!;
      const ctx = (await f.tenancy.contextFromSession(token))!;
      return { ...f, token, ctx };
    }

    it("rejects a wrong current password", async () => {
      const { tenancy, ctx, address } = await signedIn();
      await expectCode(
        tenancy.changePassword(ctx, { current: "nope-nope", next: "brand-new-pass" }),
        "invalid",
      );
      expect(await tenancy.signIn({ email: address, password: "correct-horse" })).not.toBeNull();
    });

    it("rejects a short or unchanged password", async () => {
      const { tenancy, ctx } = await signedIn();
      await expectCode(
        tenancy.changePassword(ctx, { current: "correct-horse", next: "short" }),
        "invalid",
      );
      await expectCode(
        tenancy.changePassword(ctx, { current: "correct-horse", next: "correct-horse" }),
        "invalid",
      );
    });

    it("requires an owner with a user", async () => {
      const { tenancy, tenant } = await ownerFixture();
      const input = { current: "correct-horse", next: "brand-new-pass" };
      await expectCode(
        tenancy.changePassword({ tenantId: tenant.id, actor: "owner" }, input),
        "forbidden",
      );
      await expectCode(
        tenancy.changePassword({ tenantId: tenant.id, actor: "business_agent" }, input),
        "forbidden",
      );
    });

    it("changes the password, revokes old tokens and returns a working token", async () => {
      const { tenancy, ctx, token, address } = await signedIn();
      const other = await ownerFixture();
      const otherToken = (await other.tenancy.signIn({
        email: other.address,
        password: "correct-horse",
      }))!;

      const fresh = await tenancy.changePassword(ctx, {
        current: "correct-horse",
        next: "brand-new-pass",
      });

      expect(await tenancy.contextFromSession(token)).toBeNull();
      expect(await tenancy.contextFromSession(fresh)).toMatchObject({ userId: ctx.userId });
      expect(await tenancy.signIn({ email: address, password: "correct-horse" })).toBeNull();
      expect(await tenancy.signIn({ email: address, password: "brand-new-pass" })).not.toBeNull();
      expect(await other.tenancy.contextFromSession(otherToken)).not.toBeNull();
      expect(
        await other.tenancy.signIn({ email: other.address, password: "correct-horse" }),
      ).not.toBeNull();
    });

    it("audits the change without secrets", async () => {
      const { tenancy, ctx } = await signedIn();
      await tenancy.changePassword(ctx, { current: "correct-horse", next: "brand-new-pass" });
      const rows = await testDb()
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.tenantId, ctx.tenantId),
            eq(auditEvents.action, "user.password_changed"),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0])).not.toMatch(/brand-new-pass|correct-horse|\$2/);
    });
  });

  it("does not revoke sessions across tenants", async () => {
    const a = await ownerFixture();
    const b = await ownerFixture();
    const ctx = { tenantId: b.tenant.id, actor: "owner" as const, userId: a.userId };
    await expectCode(a.tenancy.revokeSessions(ctx), "not_found");
    const token = (await a.tenancy.signIn({ email: a.address, password: "correct-horse" }))!;
    expect(await a.tenancy.contextFromSession(token)).not.toBeNull();
  });

  it("only lets an owner with a user revoke sessions", async () => {
    const { tenancy, tenant } = await ownerFixture();
    await expectCode(tenancy.revokeSessions({ tenantId: tenant.id, actor: "owner" }), "forbidden");
    await expectCode(
      tenancy.revokeSessions({ tenantId: tenant.id, actor: "business_agent" }),
      "forbidden",
    );
  });

  it("rejects a validly signed token that points a user at another tenant", async () => {
    const a = await ownerFixture();
    const b = await ownerFixture();
    const forged = signSession(
      {
        userId: a.userId,
        tenantId: b.tenant.id,
        version: 1,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
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

  it("lists keys newest first without secrets and marks revoked ones", async () => {
    const owner = await createTestTenant({ actor: "owner" });
    const tenancy = testTenancy();
    const first = await tenancy.createApiKey(owner, "owner");
    const second = await tenancy.createApiKey(owner, "customer_agent");
    await tenancy.revokeApiKey(owner, first.id);
    const list = await tenancy.listApiKeys(owner);
    expect(list.map((k) => k.id)).toEqual([second.id, first.id]);
    expect(list[0]).toMatchObject({
      kind: "customer_agent",
      prefix: second.prefix,
      revokedAt: null,
    });
    expect(list[1]?.revokedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(list)).not.toContain(second.key);
    expect(Object.keys(list[0]!)).not.toContain("keyHash");
  });

  it("lists only the tenant's own keys", async () => {
    const a = await createTestTenant({ actor: "owner" });
    const b = await createTestTenant({ actor: "owner" });
    const tenancy = testTenancy();
    await tenancy.createApiKey(a, "owner");
    expect(await tenancy.listApiKeys(b)).toEqual([]);
  });

  it("forbids listing from a non-owner context", async () => {
    const agent = await createTestTenant({ actor: "business_agent" });
    await expectCode(testTenancy().listApiKeys(agent), "forbidden");
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

describe("signUp", () => {
  it("creates a draft tenant and a session for its owner", async () => {
    const tenancy = testTenancy();
    const address = email();
    const { tenant, token } = await tenancy.signUp({
      businessName: `Sign Up ${hex()}`,
      email: `  ${address.toUpperCase()} `,
      password: "correct-horse",
    });
    expect(tenant.status).toBe("draft");
    expect(await tenancy.contextFromSession(token)).toMatchObject({
      tenantId: tenant.id,
      actor: "owner",
    });
    expect(await tenancy.signIn({ email: address, password: "correct-horse" })).toEqual(
      expect.any(String),
    );
  });

  it("rejects a duplicate email and leaves no second tenant", async () => {
    const tenancy = testTenancy();
    const address = email();
    const first = await tenancy.signUp({
      businessName: `First ${hex()}`,
      email: address,
      password: "correct-horse",
    });
    const name = `Second ${hex()}`;
    await expectCode(
      tenancy.signUp({ businessName: name, email: address, password: "correct-horse" }),
      "conflict",
    );
    const rows = await testDb().select().from(tenants).where(eq(tenants.name, name));
    expect(rows).toEqual([]);
    expect(await tenancy.contextFromSession(first.token)).not.toBeNull();
  });

  it("validates credentials before creating anything", async () => {
    const name = `Invalid ${hex()}`;
    await expectCode(
      testTenancy().signUp({ businessName: name, email: email(), password: "short" }),
      "invalid",
    );
    const rows = await testDb().select().from(tenants).where(eq(tenants.name, name));
    expect(rows).toEqual([]);
  });
});
