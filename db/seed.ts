import { fileURLToPath } from "node:url";
import { createDb, type Db } from "./client";
import { barbershopModel } from "./seed-data/barbershop";
import { shoeStoreModel } from "./seed-data/shoe-store";
import type { BusinessModelInput } from "@/shared/business-model";
import { RecordingEventPublisher } from "@/server/events/types";
import { createCatalogService } from "@/server/services/catalog";
import { createTenancyService } from "@/server/services/tenancy";

export interface SeedResult {
  slug: string;
  status: "created" | "skipped";
  ownerEmail: string;
  ownerApiKey?: string;
  customerAgentApiKey?: string;
}

export const DEMO_PASSWORD = "demo-password-123";

const DEMO_TENANTS: { slug: string; ownerEmail: string; model: BusinessModelInput }[] = [
  { slug: "stride-shoes", ownerEmail: "owner@stride-shoes.demo", model: shoeStoreModel },
  { slug: "fade-factory", ownerEmail: "owner@fade-factory.demo", model: barbershopModel },
];

export async function seedDemoTenants(
  db: Db,
  options: { authSecret: string; log?: (msg: string) => void },
): Promise<SeedResult[]> {
  const log = options.log ?? (() => {});
  const tenancy = createTenancyService(db, { authSecret: options.authSecret });
  const catalog = createCatalogService({ db, events: new RecordingEventPublisher() });
  const results: SeedResult[] = [];

  for (const demo of DEMO_TENANTS) {
    const existing = await tenancy.contextFromSlug(demo.slug, "system", { allowDraft: true });
    if (existing) {
      log(`${demo.slug}: already exists, skipped`);
      results.push({ slug: demo.slug, status: "skipped", ownerEmail: demo.ownerEmail });
      continue;
    }

    const tenant = await tenancy.createTenant({ name: demo.model.profile.name, slug: demo.slug });
    await tenancy.createOwner(tenant.id, { email: demo.ownerEmail, password: DEMO_PASSWORD });
    const system = { tenantId: tenant.id, actor: "system" as const };
    const applied = await catalog.applyBusinessModel(system, demo.model);
    await tenancy.setStatus(system, "live");
    const ownerKey = await tenancy.createApiKey({ tenantId: tenant.id, actor: "owner" }, "owner");
    const agentKey = await tenancy.createApiKey(system, "customer_agent");
    log(`${demo.slug}: created with ${applied.offers} offers`);
    results.push({
      slug: demo.slug,
      status: "created",
      ownerEmail: demo.ownerEmail,
      ownerApiKey: ownerKey.key,
      customerAgentApiKey: agentKey.key,
    });
  }
  return results;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  await import("dotenv/config");
  const url = process.env.DATABASE_URL;
  const authSecret = process.env.AUTH_SECRET;
  if (!url || !authSecret) {
    console.error("DATABASE_URL and AUTH_SECRET must be set (see .env.example)");
    process.exit(1);
  }
  const handle = createDb(url);
  try {
    const results = await seedDemoTenants(handle.db, { authSecret, log: console.log });
    console.log("\nSeed summary");
    for (const r of results) {
      console.log(`\n${r.slug} (${r.status})`);
      console.log(`  storefront: /s/${r.slug}`);
      console.log(`  owner login: ${r.ownerEmail} / ${DEMO_PASSWORD}`);
      if (r.ownerApiKey) console.log(`  owner API key: ${r.ownerApiKey}`);
      if (r.customerAgentApiKey) console.log(`  customer agent API key: ${r.customerAgentApiKey}`);
    }
  } finally {
    await handle.close();
  }
}
