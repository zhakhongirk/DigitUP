import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditEvents, passwordResetTokens, users } from "@/db/schema";
import { assertNotStaff, ServiceError } from "@/server/services/context";
import { generateResetToken, hashResetToken } from "@/server/services/tenancy/tokens";
import { canAccessPath } from "@/shared/staff-access";
import { testDb, testTenancy, uniqueSlug } from "../helpers/db";

const tenancy = testTenancy();

async function owner() {
  const email = `${uniqueSlug("o")}@example.com`;
  const { tenant, token } = await tenancy.signUp({
    businessName: `Shop ${uniqueSlug("b")}`,
    email,
    password: "correct-horse",
  });
  const ctx = (await tenancy.contextFromSession(token))!;
  return { tenant, token, ctx, email };
}

async function sessionVersion(email: string): Promise<number> {
  const [row] = await testDb().select().from(users).where(eq(users.email, email));
  return row!.sessionVersion;
}

async function tokenRows(email: string) {
  const [user] = await testDb().select().from(users).where(eq(users.email, email));
  return testDb()
    .select()
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.userId, user!.id));
}

describe("reset tokens", () => {
  it("are random and stored only as a hash", () => {
    const a = generateResetToken();
    const b = generateResetToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.raw.length).toBeGreaterThanOrEqual(40);
    expect(a.hash).toBe(hashResetToken(a.raw));
    expect(a.hash).not.toContain(a.raw);
  });
});

describe("password reset", () => {
  it("issues a 30 minute token and keeps only its hash", async () => {
    const { email } = await owner();
    const before = Date.now();
    const issued = await tenancy.requestPasswordReset(email.toUpperCase());
    expect(issued).not.toBeNull();
    const rows = await tokenRows(email);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashResetToken(issued!.token));
    expect(rows[0]!.tokenHash).not.toBe(issued!.token);
    const ttl = rows[0]!.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThan(29 * 60_000);
    expect(ttl).toBeLessThanOrEqual(30 * 60_000 + 5_000);
  });

  it("returns nothing for an unknown address", async () => {
    expect(await tenancy.requestPasswordReset(`${uniqueSlug("x")}@example.com`)).toBeNull();
  });

  it("sets the password, revokes sessions and can be used once", async () => {
    const { email, token: session } = await owner();
    const versionBefore = await sessionVersion(email);
    const issued = (await tenancy.requestPasswordReset(email))!;

    await tenancy.resetPassword(issued.token, "brand-new-pass");

    expect(await sessionVersion(email)).toBe(versionBefore + 1);
    expect(await tenancy.contextFromSession(session)).toBeNull();
    expect(await tenancy.signIn({ email, password: "correct-horse" })).toBeNull();
    expect(await tenancy.signIn({ email, password: "brand-new-pass" })).not.toBeNull();
    const [row] = await tokenRows(email);
    expect(row!.usedAt).not.toBeNull();

    await expect(tenancy.resetPassword(issued.token, "another-pass-1")).rejects.toMatchObject({
      code: "invalid",
    });
    expect(await tenancy.signIn({ email, password: "brand-new-pass" })).not.toBeNull();
  });

  it("rejects an expired token", async () => {
    const { email } = await owner();
    const issued = (await tenancy.requestPasswordReset(email))!;
    await testDb()
      .update(passwordResetTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(passwordResetTokens.tokenHash, hashResetToken(issued.token)));
    await expect(tenancy.resetPassword(issued.token, "brand-new-pass")).rejects.toThrow(
      "invalid or has expired",
    );
    expect(await tenancy.signIn({ email, password: "correct-horse" })).not.toBeNull();
  });

  it("rejects unknown tokens and short passwords", async () => {
    const { email } = await owner();
    const issued = (await tenancy.requestPasswordReset(email))!;
    await expect(tenancy.resetPassword("nope", "brand-new-pass")).rejects.toBeInstanceOf(
      ServiceError,
    );
    await expect(tenancy.resetPassword(issued.token, "short")).rejects.toMatchObject({
      code: "invalid",
    });
    const [row] = await tokenRows(email);
    expect(row!.usedAt).toBeNull();
  });

  it("invalidates earlier tokens when a new one is requested or one is used", async () => {
    const { email } = await owner();
    const first = (await tenancy.requestPasswordReset(email))!;
    const second = (await tenancy.requestPasswordReset(email))!;
    await expect(tenancy.resetPassword(first.token, "brand-new-pass")).rejects.toMatchObject({
      code: "invalid",
    });
    await tenancy.resetPassword(second.token, "brand-new-pass");
    const third = (await tenancy.requestPasswordReset(email))!;
    const fourth = (await tenancy.requestPasswordReset(email))!;
    expect(third.token).not.toBe(fourth.token);
    await tenancy.resetPassword(fourth.token, "brand-new-pass-2");
    const rows = await tokenRows(email);
    expect(rows.every((row) => row.usedAt !== null)).toBe(true);
  });

  it("records audit events", async () => {
    const { email, tenant } = await owner();
    const issued = (await tenancy.requestPasswordReset(email))!;
    await tenancy.resetPassword(issued.token, "brand-new-pass");
    const events = await testDb()
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.tenantId, tenant.id));
    const actions = events.map((event) => event.action);
    expect(actions).toContain("user.password_reset_requested");
    expect(actions).toContain("user.password_reset");
  });
});

describe("staff", () => {
  it("is invited into the owner's tenant with a 7 day token", async () => {
    const { ctx, tenant } = await owner();
    const staffEmail = `${uniqueSlug("s")}@example.com`;
    const invite = await tenancy.inviteStaff(ctx, staffEmail);

    const [row] = await testDb().select().from(users).where(eq(users.email, staffEmail));
    expect(row).toMatchObject({ tenantId: tenant.id, role: "staff" });
    const [stored] = await tokenRows(staffEmail);
    const ttl = stored!.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(6.9 * 24 * 3600_000);
    expect(stored!.tokenHash).toBe(hashResetToken(invite.token));

    await tenancy.resetPassword(invite.token, "staff-password");
    const session = (await tenancy.signIn({ email: staffEmail, password: "staff-password" }))!;
    const staffCtx = (await tenancy.contextFromSession(session))!;
    expect(staffCtx).toMatchObject({ tenantId: tenant.id, role: "staff" });
    expect((await tenancy.listStaff(ctx)).map((m) => m.email)).toEqual([staffEmail]);
  });

  it("cannot reuse an address that is already registered", async () => {
    const { ctx, email } = await owner();
    await expect(tenancy.inviteStaff(ctx, email)).rejects.toMatchObject({ code: "conflict" });
    await expect(tenancy.inviteStaff(ctx, "not-an-email")).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("is removed along with its sessions, only within the same tenant", async () => {
    const { ctx } = await owner();
    const other = await owner();
    const staffEmail = `${uniqueSlug("s")}@example.com`;
    const invite = await tenancy.inviteStaff(ctx, staffEmail);
    await tenancy.resetPassword(invite.token, "staff-password");
    const session = (await tenancy.signIn({ email: staffEmail, password: "staff-password" }))!;
    const [staff] = await tenancy.listStaff(ctx);

    await expect(tenancy.removeStaff(other.ctx, staff!.id)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await tenancy.contextFromSession(session)).not.toBeNull();

    await tenancy.removeStaff(ctx, staff!.id);
    expect(await tenancy.contextFromSession(session)).toBeNull();
    expect(await tenancy.listStaff(ctx)).toEqual([]);
    await expect(tenancy.removeStaff(ctx, ctx.userId!)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("records invite and removal in the audit log", async () => {
    const { ctx, tenant } = await owner();
    const staffEmail = `${uniqueSlug("s")}@example.com`;
    await tenancy.inviteStaff(ctx, staffEmail);
    const [staff] = await tenancy.listStaff(ctx);
    await tenancy.removeStaff(ctx, staff!.id);
    const events = await testDb()
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.tenantId, tenant.id));
    const actions = events.map((event) => event.action);
    expect(actions).toContain("staff.invited");
    expect(actions).toContain("staff.removed");
  });

  it("cannot manage staff, API keys or approvals", async () => {
    const { ctx } = await owner();
    const staffEmail = `${uniqueSlug("s")}@example.com`;
    const invite = await tenancy.inviteStaff(ctx, staffEmail);
    await tenancy.resetPassword(invite.token, "staff-password");
    const session = (await tenancy.signIn({ email: staffEmail, password: "staff-password" }))!;
    const staffCtx = (await tenancy.contextFromSession(session))!;

    await expect(tenancy.inviteStaff(staffCtx, "x@example.com")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(tenancy.listStaff(staffCtx)).rejects.toMatchObject({ code: "forbidden" });
    await expect(tenancy.removeStaff(staffCtx, ctx.userId!)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(tenancy.createApiKey(staffCtx, "customer_agent")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(tenancy.listApiKeys(staffCtx)).rejects.toMatchObject({ code: "forbidden" });
    expect(() => assertNotStaff(staffCtx)).toThrow(ServiceError);
    expect(() => assertNotStaff(ctx)).not.toThrow();
  });
});

describe("staff page access", () => {
  it("allows inbox and catalog and blocks everything else", () => {
    for (const path of ["/app/inbox", "/app/catalog", "/app/catalog/new", "/app/export/orders"]) {
      expect(canAccessPath("staff", path), path).toBe(true);
    }
    for (const path of [
      "/app",
      "/app/settings",
      "/app/agents",
      "/app/approvals",
      "/app/audit",
      "/app/analytics",
      "/app/notifications",
      "/app/catalog/import",
      "/app/inboxes",
    ]) {
      expect(canAccessPath("staff", path), path).toBe(false);
    }
  });

  it("lets owners open every page", () => {
    for (const path of ["/app", "/app/settings", "/app/agents", "/app/audit"]) {
      expect(canAccessPath("owner", path), path).toBe(true);
    }
  });
});
