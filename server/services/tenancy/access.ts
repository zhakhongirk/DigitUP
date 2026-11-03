import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, asc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { passwordResetTokens, users } from "@/db/schema";
import { recordAudit } from "../audit";
import { assertNotStaff, assertOwner, ServiceError, type TenantContext } from "../context";
import {
  generateResetToken,
  hashResetToken,
  INVITE_TOKEN_TTL_MS,
  RESET_TOKEN_TTL_MS,
} from "./tokens";

export interface IssuedToken {
  /** Shown once in the emailed link; only the hash is stored. */
  token: string;
  email: string;
  expiresAt: Date;
}

export interface StaffMember {
  id: string;
  email: string;
  createdAt: Date;
}

export interface AccessService {
  /** Null when no account has this email; callers must not reveal that. */
  requestPasswordReset(email: string): Promise<IssuedToken | null>;
  resetPassword(token: string, password: string): Promise<void>;
  inviteStaff(ctx: TenantContext, email: string): Promise<IssuedToken>;
  listStaff(ctx: TenantContext): Promise<StaffMember[]>;
  removeStaff(ctx: TenantContext, userId: string): Promise<void>;
}

interface Options {
  bcryptRounds: number;
  now?: () => Date;
}

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function createAccessService(db: Db, options: Options): AccessService {
  const now = options.now ?? (() => new Date());

  async function issue(
    tx: Pick<Db, "insert" | "update">,
    userId: string,
    ttlMs: number,
  ): Promise<{ token: string; expiresAt: Date }> {
    const generated = generateResetToken();
    const expiresAt = new Date(now().getTime() + ttlMs);
    await tx
      .update(passwordResetTokens)
      .set({ usedAt: now() })
      .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
    await tx.insert(passwordResetTokens).values({ userId, tokenHash: generated.hash, expiresAt });
    return { token: generated.raw, expiresAt };
  }

  return {
    async requestPasswordReset(rawEmail) {
      const email = rawEmail.trim().toLowerCase();
      const [user] = await db.select().from(users).where(eq(users.email, email));
      if (!user) return null;
      return db.transaction(async (tx) => {
        const issued = await issue(tx, user.id, RESET_TOKEN_TTL_MS);
        await recordAudit(
          tx,
          { tenantId: user.tenantId, actor: "system", userId: user.id },
          { action: "user.password_reset_requested", entity: "user", entityId: user.id },
        );
        return { ...issued, email };
      });
    },

    async resetPassword(token, password) {
      if (password.length < 8) {
        throw new ServiceError("invalid", "Password must be at least 8 characters");
      }
      const passwordHash = await bcrypt.hash(password, options.bcryptRounds);
      const hash = hashResetToken(token);
      await db.transaction(async (tx) => {
        const at = now();
        const [used] = await tx
          .update(passwordResetTokens)
          .set({ usedAt: at })
          .where(
            and(
              eq(passwordResetTokens.tokenHash, hash),
              isNull(passwordResetTokens.usedAt),
              gt(passwordResetTokens.expiresAt, at),
            ),
          )
          .returning({ userId: passwordResetTokens.userId });
        if (!used) throw new ServiceError("invalid", "This link is invalid or has expired");
        const [user] = await tx
          .update(users)
          .set({ passwordHash, sessionVersion: sql`${users.sessionVersion} + 1` })
          .where(eq(users.id, used.userId))
          .returning({ id: users.id, tenantId: users.tenantId });
        if (!user) throw new ServiceError("invalid", "This link is invalid or has expired");
        await tx
          .update(passwordResetTokens)
          .set({ usedAt: at })
          .where(and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.usedAt)));
        await recordAudit(
          tx,
          { tenantId: user.tenantId, actor: "system", userId: user.id },
          { action: "user.password_reset", entity: "user", entityId: user.id },
        );
      });
    },

    async inviteStaff(ctx, rawEmail) {
      assertOwner(ctx);
      assertNotStaff(ctx);
      const email = rawEmail.trim().toLowerCase();
      if (!EMAIL_PATTERN.test(email))
        throw new ServiceError("invalid", "A valid email is required");
      const passwordHash = await bcrypt.hash(randomBytes(24).toString("hex"), options.bcryptRounds);
      return db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({ tenantId: ctx.tenantId, email, passwordHash, role: "staff" })
          .onConflictDoNothing({ target: users.email })
          .returning({ id: users.id });
        if (!user) throw new ServiceError("conflict", "This email is already registered");
        const issued = await issue(tx, user.id, INVITE_TOKEN_TTL_MS);
        await recordAudit(tx, ctx, {
          action: "staff.invited",
          entity: "user",
          entityId: user.id,
          after: { email },
        });
        return { ...issued, email };
      });
    },

    async listStaff(ctx) {
      assertOwner(ctx);
      assertNotStaff(ctx);
      return db
        .select({ id: users.id, email: users.email, createdAt: users.createdAt })
        .from(users)
        .where(and(eq(users.tenantId, ctx.tenantId), ne(users.role, "owner")))
        .orderBy(asc(users.createdAt));
    },

    async removeStaff(ctx, userId) {
      assertOwner(ctx);
      assertNotStaff(ctx);
      await db.transaction(async (tx) => {
        const [row] = await tx
          .delete(users)
          .where(
            and(eq(users.id, userId), eq(users.tenantId, ctx.tenantId), eq(users.role, "staff")),
          )
          .returning({ id: users.id, email: users.email });
        if (!row) throw new ServiceError("not_found", "Staff member not found");
        await recordAudit(tx, ctx, {
          action: "staff.removed",
          entity: "user",
          entityId: row.id,
          before: { email: row.email },
        });
      });
    },
  };
}
