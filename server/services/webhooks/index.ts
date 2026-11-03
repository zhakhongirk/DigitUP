import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { kv } from "@/db/schema";
import { assertPublicWebhookUrl, type Resolver } from "./guard";
import { newWebhookSecret } from "./sign";

export interface WebhookConfig {
  url: string;
  secret: string;
}

export interface WebhookService {
  /** Stores the URL with a fresh signing secret; the secret is only ever shown by this call. */
  set(tenantId: string, url: string): Promise<WebhookConfig>;
  clear(tenantId: string): Promise<boolean>;
  get(tenantId: string): Promise<WebhookConfig | null>;
}

const keyFor = (tenantId: string) => `customer_webhook:${tenantId}`;

export function createWebhookService(db: Db, resolver?: Resolver): WebhookService {
  return {
    async set(tenantId, rawUrl) {
      const url = (await assertPublicWebhookUrl(rawUrl, resolver)).toString();
      const config: WebhookConfig = { url, secret: newWebhookSecret() };
      const value = JSON.stringify(config);
      await db
        .insert(kv)
        .values({ key: keyFor(tenantId), value })
        .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
      return config;
    },

    async clear(tenantId) {
      const removed = await db
        .delete(kv)
        .where(eq(kv.key, keyFor(tenantId)))
        .returning();
      return removed.length > 0;
    },

    async get(tenantId) {
      const [row] = await db
        .select()
        .from(kv)
        .where(eq(kv.key, keyFor(tenantId)));
      if (!row) return null;
      try {
        const parsed = JSON.parse(row.value) as Partial<WebhookConfig>;
        return typeof parsed.url === "string" && typeof parsed.secret === "string"
          ? { url: parsed.url, secret: parsed.secret }
          : null;
      } catch {
        return null;
      }
    },
  };
}
