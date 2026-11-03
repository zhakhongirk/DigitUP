import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { apiKeys, businessProfiles, tenants, users } from "@/db/schema";
import { recordAudit } from "../audit";
import { assertOwner, ServiceError, type Actor, type TenantContext } from "../context";
import {
  generateApiKey,
  hashApiKey,
  signSession,
  slugify,
  verifySession,
  type ApiKeyKind,
} from "./tokens";

export type Tenant = typeof tenants.$inferSelect;
export type TenantStatus = Tenant["status"];

export interface CreatedApiKey {
  id: string;
  kind: ApiKeyKind;
  /** Shown once; only the hash is stored. */
  key: string;
  prefix: string;
}

export interface ApiKeySummary {
  id: string;
  kind: ApiKeyKind;
  prefix: string;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface TenancyService {
  createTenant(input: { name: string; slug?: string }): Promise<Tenant>;
  getTenant(ctx: TenantContext): Promise<Tenant>;
  setStatus(ctx: TenantContext, status: TenantStatus): Promise<Tenant>;

  createOwner(
    tenantId: string,
    input: { email: string; password: string },
  ): Promise<{ userId: string }>;
  /**
   * Creates a draft tenant with its owner and returns a session token. The
   * tenant is removed again when the owner cannot be created.
   */
  signUp(input: {
    businessName: string;
    email: string;
    password: string;
  }): Promise<{ tenant: Tenant; token: string }>;
  /** Returns a session token, or null when the credentials are wrong. */
  signIn(input: { email: string; password: string }): Promise<string | null>;

  createApiKey(ctx: TenantContext, kind: ApiKeyKind): Promise<CreatedApiKey>;
  revokeApiKey(ctx: TenantContext, apiKeyId: string): Promise<void>;
  /** Newest first, revoked keys included. Never returns hashes. */
  listApiKeys(ctx: TenantContext): Promise<ApiKeySummary[]>;

  /**
   * Verifies the current password, sets a new one and ends all other sessions.
   * Returns a fresh session token for the signed-in user.
   */
  changePassword(ctx: TenantContext, input: { current: string; next: string }): Promise<string>;
  /** Invalidates every session token issued to the signed-in user. */
  revokeSessions(ctx: TenantContext): Promise<void>;
  /** Owner context from a session token. */
  contextFromSession(token: string): Promise<TenantContext | null>;
  /** Context from an API key of the expected kind; the actor is chosen by the caller. */
  contextFromApiKey(key: string, kind: ApiKeyKind, actor: Actor): Promise<TenantContext | null>;
  /** Customer-facing context from a storefront slug; only live tenants resolve unless allowed. */
  contextFromSlug(
    slug: string,
    actor: Actor,
    options?: { allowDraft?: boolean },
  ): Promise<TenantContext | null>;
}

export interface TenancyOptions {
  authSecret: string;
  /** Session lifetime in seconds (default 7 days). */
  sessionTtlSeconds?: number;
  bcryptRounds?: number;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

export function createTenancyService(db: Db, options: TenancyOptions): TenancyService {
  if (options.authSecret.length < 16) {
    throw new Error("AUTH_SECRET must be at least 16 characters");
  }
  const ttl = options.sessionTtlSeconds ?? 7 * 24 * 3600;
  const rounds = options.bcryptRounds ?? 10;
  let dummyHash: string | undefined;

  async function loadTenant(tenantId: string): Promise<Tenant> {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    if (!tenant) throw new ServiceError("not_found", "Tenant not found");
    return tenant;
  }

  const service: TenancyService = {
    async createTenant(input) {
      const name = input.name.trim();
      if (name === "") throw new ServiceError("invalid", "Business name is required");
      if (input.slug !== undefined && !SLUG_PATTERN.test(input.slug)) {
        throw new ServiceError("invalid", "Slug must be 3-64 lowercase letters, digits or dashes");
      }

      const base = input.slug ?? slugify(name);
      for (let attempt = 0; attempt < 5; attempt++) {
        const slug =
          attempt === 0 && (input.slug || base !== "store")
            ? base
            : `${base}-${randomBytes(3).toString("hex")}`;
        const created = await db.transaction(async (tx) => {
          const [tenant] = await tx
            .insert(tenants)
            .values({ name, slug })
            .onConflictDoNothing({ target: tenants.slug })
            .returning();
          if (!tenant) return null;
          await tx.insert(businessProfiles).values({ tenantId: tenant.id });
          await recordAudit(
            tx,
            { tenantId: tenant.id, actor: "system" },
            { action: "tenant.created", entity: "tenant", entityId: tenant.id, after: tenant },
          );
          return tenant;
        });
        if (created) return created;
        if (input.slug) throw new ServiceError("conflict", `Slug "${input.slug}" is taken`);
      }
      throw new ServiceError("conflict", "Could not allocate a unique slug");
    },

    getTenant: (ctx) => loadTenant(ctx.tenantId),

    async setStatus(ctx, status) {
      return db.transaction(async (tx) => {
        const before = await loadTenant(ctx.tenantId);
        const [after] = await tx
          .update(tenants)
          .set({ status })
          .where(eq(tenants.id, ctx.tenantId))
          .returning();
        await recordAudit(tx, ctx, {
          action: "tenant.status_changed",
          entity: "tenant",
          entityId: ctx.tenantId,
          before: { status: before.status },
          after: { status },
        });
        return after!;
      });
    },

    async createOwner(tenantId, input) {
      const email = input.email.trim().toLowerCase();
      validateCredentials(email, input.password);
      const passwordHash = await bcrypt.hash(input.password, rounds);
      return db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({ tenantId, email, passwordHash })
          .onConflictDoNothing({ target: users.email })
          .returning({ id: users.id });
        if (!user) throw new ServiceError("conflict", "This email is already registered");
        await recordAudit(
          tx,
          { tenantId, actor: "system" },
          { action: "user.created", entity: "user", entityId: user.id, after: { email } },
        );
        return { userId: user.id };
      });
    },

    async signUp(input) {
      const email = input.email.trim().toLowerCase();
      validateCredentials(email, input.password);
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email));
      if (existing) throw new ServiceError("conflict", "This email is already registered");
      const tenant = await service.createTenant({ name: input.businessName });
      try {
        const { userId } = await service.createOwner(tenant.id, {
          email,
          password: input.password,
        });
        const token = signSession(
          { userId, tenantId: tenant.id, version: 1, exp: Math.floor(Date.now() / 1000) + ttl },
          options.authSecret,
        );
        return { tenant, token };
      } catch (error) {
        await db.delete(tenants).where(eq(tenants.id, tenant.id));
        throw error;
      }
    },

    async signIn(input) {
      const email = input.email.trim().toLowerCase();
      const [user] = await db.select().from(users).where(eq(users.email, email));
      // Compare against a dummy hash when the user is missing to keep timing uniform.
      dummyHash ??= await bcrypt.hash(randomBytes(16).toString("hex"), rounds);
      const ok = await bcrypt.compare(input.password, user?.passwordHash ?? dummyHash);
      if (!user || !ok) return null;
      return signSession(
        {
          userId: user.id,
          tenantId: user.tenantId,
          version: user.sessionVersion,
          exp: Math.floor(Date.now() / 1000) + ttl,
        },
        options.authSecret,
      );
    },

    async createApiKey(ctx, kind) {
      if (kind === "owner") assertOwner(ctx);
      const generated = generateApiKey(kind);
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(apiKeys)
          .values({
            tenantId: ctx.tenantId,
            kind,
            keyHash: generated.hash,
            prefix: generated.prefix,
          })
          .returning({ id: apiKeys.id });
        await recordAudit(tx, ctx, {
          action: "api_key.created",
          entity: "api_key",
          entityId: row!.id,
          after: { kind, prefix: generated.prefix },
        });
        return { id: row!.id, kind, key: generated.raw, prefix: generated.prefix };
      });
    },

    async revokeApiKey(ctx, apiKeyId) {
      assertOwner(ctx);
      await db.transaction(async (tx) => {
        const [row] = await tx
          .update(apiKeys)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(apiKeys.id, apiKeyId),
              eq(apiKeys.tenantId, ctx.tenantId),
              isNull(apiKeys.revokedAt),
            ),
          )
          .returning({ id: apiKeys.id, prefix: apiKeys.prefix });
        if (!row) throw new ServiceError("not_found", "API key not found");
        await recordAudit(tx, ctx, {
          action: "api_key.revoked",
          entity: "api_key",
          entityId: row.id,
          before: { prefix: row.prefix },
        });
      });
    },

    async listApiKeys(ctx) {
      assertOwner(ctx);
      return db
        .select({
          id: apiKeys.id,
          kind: apiKeys.kind,
          prefix: apiKeys.prefix,
          createdAt: apiKeys.createdAt,
          revokedAt: apiKeys.revokedAt,
        })
        .from(apiKeys)
        .where(eq(apiKeys.tenantId, ctx.tenantId))
        .orderBy(desc(apiKeys.createdAt));
    },

    async revokeSessions(ctx) {
      assertOwner(ctx);
      if (!ctx.userId) throw new ServiceError("forbidden", "A signed-in user is required");
      await db.transaction(async (tx) => {
        const [row] = await tx
          .update(users)
          .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
          .where(and(eq(users.id, ctx.userId!), eq(users.tenantId, ctx.tenantId)))
          .returning({ id: users.id });
        if (!row) throw new ServiceError("not_found", "User not found");
        await recordAudit(tx, ctx, {
          action: "user.sessions_revoked",
          entity: "user",
          entityId: row.id,
        });
      });
    },

    async changePassword(ctx, input) {
      assertOwner(ctx);
      if (!ctx.userId) throw new ServiceError("forbidden", "A signed-in user is required");
      const userId = ctx.userId;
      const [user] = await db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(and(eq(users.id, userId), eq(users.tenantId, ctx.tenantId)));
      if (!user) throw new ServiceError("not_found", "User not found");
      if (!(await bcrypt.compare(input.current, user.passwordHash))) {
        throw new ServiceError("invalid", "Current password is wrong");
      }
      if (input.next.length < 8) {
        throw new ServiceError("invalid", "Password must be at least 8 characters");
      }
      if (input.next === input.current) {
        throw new ServiceError("invalid", "New password must differ from the current one");
      }
      const passwordHash = await bcrypt.hash(input.next, rounds);
      const version = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(users)
          .set({ passwordHash, sessionVersion: sql`${users.sessionVersion} + 1` })
          .where(
            and(
              eq(users.id, userId),
              eq(users.tenantId, ctx.tenantId),
              eq(users.passwordHash, user.passwordHash),
            ),
          )
          .returning({ sessionVersion: users.sessionVersion });
        if (!row) throw new ServiceError("conflict", "Password was changed elsewhere. Try again");
        await recordAudit(tx, ctx, {
          action: "user.password_changed",
          entity: "user",
          entityId: userId,
        });
        return row.sessionVersion;
      });
      return signSession(
        {
          userId,
          tenantId: ctx.tenantId,
          version,
          exp: Math.floor(Date.now() / 1000) + ttl,
        },
        options.authSecret,
      );
    },

    async contextFromSession(token) {
      const claims = verifySession(token, options.authSecret);
      if (!claims) return null;
      const [user] = await db
        .select({ id: users.id, tenantId: users.tenantId, sessionVersion: users.sessionVersion })
        .from(users)
        .where(and(eq(users.id, claims.userId), eq(users.tenantId, claims.tenantId)));
      if (!user || user.sessionVersion !== claims.version) return null;
      return { tenantId: user.tenantId, actor: "owner", userId: user.id };
    },

    async contextFromApiKey(key, kind, actor) {
      const [row] = await db
        .select({ tenantId: apiKeys.tenantId })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.keyHash, hashApiKey(key)),
            eq(apiKeys.kind, kind),
            isNull(apiKeys.revokedAt),
          ),
        );
      return row ? { tenantId: row.tenantId, actor } : null;
    },

    async contextFromSlug(slug, actor, opts = {}) {
      const [tenant] = await db
        .select({ id: tenants.id, status: tenants.status })
        .from(tenants)
        .where(eq(tenants.slug, slug.toLowerCase()));
      if (!tenant) return null;
      if (tenant.status !== "live" && !opts.allowDraft) return null;
      return { tenantId: tenant.id, actor };
    },
  };
  return service;
}

function validateCredentials(email: string, password: string) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new ServiceError("invalid", "A valid email is required");
  }
  if (password.length < 8) {
    throw new ServiceError("invalid", "Password must be at least 8 characters");
  }
}

export { slugify, verifySession, signSession, hashApiKey } from "./tokens";
export type { ApiKeyKind, SessionClaims } from "./tokens";
