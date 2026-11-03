import { beforeEach, describe, expect, it, vi } from "vitest";
import { createKey, revokeKey } from "@/app/app/agents/actions";
import { form, resetSession, revalidate, session, signUpOwner, testServices } from "./harness";

vi.mock("next/headers", async () => (await import("./harness")).headersMock());
vi.mock("next/cache", async () => (await import("./harness")).cacheMock());
vi.mock("next/navigation", async () => (await import("./harness")).navigationMock());
vi.mock("@/server/container", async () => (await import("./harness")).containerMock());

const EXPIRED = "Your session has expired. Sign in again.";
const createState = { key: null, kind: null, error: null };

beforeEach(resetSession);

describe("createKey", () => {
  it("returns an expired-session error without a session", async () => {
    const result = await createKey(createState, form({ kind: "owner" }));
    expect(result).toEqual({ key: null, kind: null, error: EXPIRED });
  });

  it("creates keys of both kinds and stores them for the tenant", async () => {
    const { ctx, token } = await signUpOwner();
    session.token = token;
    const agent = await createKey(createState, form({ kind: "customer_agent" }));
    const owner = await createKey(createState, form({ kind: "owner" }));
    expect(agent).toMatchObject({ kind: "customer_agent", error: null });
    expect(owner).toMatchObject({ kind: "owner", error: null });
    expect(agent.key).toEqual(expect.any(String));
    const keys = await testServices().tenancy.listApiKeys(ctx);
    expect(keys.map((k) => k.kind).sort()).toEqual(["customer_agent", "owner"]);
    expect(revalidate).toHaveBeenCalledWith("/app/agents");
  });

  it("rejects an unknown key type", async () => {
    const { ctx, token } = await signUpOwner();
    session.token = token;
    const result = await createKey(createState, form({ kind: "admin" }));
    expect(result).toEqual({ key: null, kind: null, error: "Choose a key type." });
    expect(await testServices().tenancy.listApiKeys(ctx)).toHaveLength(0);
  });
});

describe("revokeKey", () => {
  it("returns an expired-session error without a session", async () => {
    expect(await revokeKey({ error: null }, form({ id: "x" }))).toEqual({ error: EXPIRED });
  });

  it("revokes a key of the tenant", async () => {
    const { ctx, token } = await signUpOwner();
    session.token = token;
    const created = await testServices().tenancy.createApiKey(ctx, "customer_agent");
    const result = await revokeKey({ error: null }, form({ id: created.id }));
    expect(result).toEqual({ error: null });
    const [stored] = await testServices().tenancy.listApiKeys(ctx);
    expect(stored?.revokedAt).toBeInstanceOf(Date);
    expect(revalidate).toHaveBeenCalledWith("/app/agents");
  });

  it("reports a missing id and an already revoked key", async () => {
    const { ctx, token } = await signUpOwner();
    session.token = token;
    expect(await revokeKey({ error: null }, form({}))).toEqual({ error: "Nothing selected." });
    const created = await testServices().tenancy.createApiKey(ctx, "owner");
    await revokeKey({ error: null }, form({ id: created.id }));
    const again = await revokeKey({ error: null }, form({ id: created.id }));
    expect(again.error).toEqual(expect.any(String));
  });

  it("cannot revoke another tenant's key", async () => {
    const other = await signUpOwner();
    const mine = await signUpOwner();
    const foreign = await testServices().tenancy.createApiKey(other.ctx, "customer_agent");
    session.token = mine.token;
    const result = await revokeKey({ error: null }, form({ id: foreign.id }));
    expect(result.error).toEqual(expect.any(String));
    const [stored] = await testServices().tenancy.listApiKeys(other.ctx);
    expect(stored?.revokedAt).toBeNull();
  });
});
