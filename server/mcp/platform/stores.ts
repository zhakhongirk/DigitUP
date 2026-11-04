import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { businessProfiles, tenants } from "@/db/schema";
import { contactsSchema } from "@/shared/business-model";
import type { TenantContext } from "@/server/services/context";

export interface LiveStore {
  ctx: TenantContext;
  slug: string;
  name: string;
  description: string;
  category: string | null;
  city: string | null;
}

export interface StoreDirectory {
  /** Live stores, oldest first, optionally narrowed by free text and city. */
  list(options?: { query?: string; city?: string; limit?: number }): Promise<LiveStore[]>;
  /** A live store by slug, or null when it does not exist or is not live. */
  find(slug: string): Promise<LiveStore | null>;
}

function toStore(row: {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  contacts: unknown;
}): LiveStore {
  const contacts = contactsSchema.safeParse(row.contacts);
  return {
    ctx: { tenantId: row.id, actor: "customer_agent" },
    slug: row.slug,
    name: row.name,
    description: row.description ?? "",
    category: row.category,
    city: contacts.success ? (contacts.data.address ?? null) : null,
  };
}

function includes(haystack: string | null, needle: string): boolean {
  return (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
}

export function createStoreDirectory(db: Db): StoreDirectory {
  const select = (slug?: string) =>
    db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        description: businessProfiles.description,
        category: businessProfiles.category,
        contacts: businessProfiles.contacts,
      })
      .from(tenants)
      .leftJoin(businessProfiles, eq(businessProfiles.tenantId, tenants.id))
      .where(and(eq(tenants.status, "live"), slug ? eq(tenants.slug, slug) : undefined))
      .orderBy(asc(tenants.createdAt), asc(tenants.id));

  return {
    async list({ query, city, limit = 50 } = {}) {
      const stores = (await select()).map(toStore);
      const text = query?.trim();
      const place = city?.trim();
      return stores
        .filter(
          (s) =>
            (!text ||
              includes(s.name, text) ||
              includes(s.description, text) ||
              includes(s.category, text) ||
              includes(s.slug, text)) &&
            (!place || includes(s.city, place)),
        )
        .slice(0, limit);
    },
    async find(slug) {
      const [row] = await select(slug.toLowerCase());
      return row ? toStore(row) : null;
    },
  };
}
