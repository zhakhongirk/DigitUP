import { randomBytes } from "node:crypto";
import { afterAll } from "vitest";
import { createDb, type Db } from "@/db/client";
import { RecordingEventPublisher } from "@/server/events/types";
import type { Actor, TenantContext } from "@/server/services/context";
import { createTenancyService, type TenancyService } from "@/server/services/tenancy";
import { testDatabaseUrl } from "./test-db-url";

export const TEST_AUTH_SECRET = "test-secret-at-least-16-chars";

let handle: ReturnType<typeof createDb> | undefined;

/**
 * Shared database client for the current test file, closed after the file.
 * Tests isolate themselves by creating their own tenants (unique slugs), so no
 * truncation is needed and files can run in parallel.
 */
export function testDb(): Db {
  if (!handle) {
    handle = createDb(testDatabaseUrl());
    const current = handle;
    afterAll(async () => {
      await current.close();
      handle = undefined;
    });
  }
  return handle.db;
}

export function testTenancy(db: Db = testDb()): TenancyService {
  return createTenancyService(db, { authSecret: TEST_AUTH_SECRET, bcryptRounds: 4 });
}

export function uniqueSlug(prefix = "t"): string {
  return `${prefix}-${randomBytes(5).toString("hex")}`;
}

/** Creates a fresh tenant and returns a context for it with the given actor. */
export async function createTestTenant(
  options: { actor?: Actor; name?: string; live?: boolean } = {},
): Promise<TenantContext & { slug: string }> {
  const tenancy = testTenancy();
  const tenant = await tenancy.createTenant({
    name: options.name ?? "Test Business",
    slug: uniqueSlug(),
  });
  const ctx: TenantContext = { tenantId: tenant.id, actor: options.actor ?? "owner" };
  if (options.live) await tenancy.setStatus({ ...ctx, actor: "system" }, "live");
  return { ...ctx, slug: tenant.slug };
}

export function recordingEvents(): RecordingEventPublisher {
  return new RecordingEventPublisher();
}
