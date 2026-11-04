/**
 * Resolves the offer or model names in queries.jsonl to offer ids of the seeded stores (every
 * size variant of a model) and copies price, currency, price status and availability from the
 * database. Read-only.
 *
 *   pnpm eval:gold
 *
 * Writes gold.jsonl and catalog.json next to this file. Run it again after every db:reset.
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { offers, tenants } from "@/db/schema";
import type { Fact, Gold } from "./score";
import { evalDir as dir, readQueries } from "./shared";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set");
  const handle = createDb(url);
  try {
    const catalog: Record<string, Record<string, Fact & { title: string }>> = {};
    const idsByName: Record<string, Map<string, string[]>> = {};
    const queries = readQueries();
    for (const slug of new Set(queries.map((q) => q.store))) {
      const [tenant] = await handle.db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, slug));
      if (!tenant) throw new Error(`Store ${slug} not found; run pnpm db:seed`);
      const rows = await handle.db
        .select()
        .from(offers)
        .where(and(eq(offers.tenantId, tenant.id), eq(offers.status, "active")));
      catalog[slug] = {};
      const names = new Map<string, string[]>();
      idsByName[slug] = names;
      for (const row of rows) {
        for (const name of new Set([row.title, row.model ?? row.title])) {
          names.set(name, [...(names.get(name) ?? []), row.id]);
        }
        catalog[slug][row.id] = {
          title: row.title,
          model: row.model,
          price: row.priceStatus === "confirmed" ? row.price : null,
          currency: row.priceStatus === "confirmed" ? row.currency : null,
          price_status: row.priceStatus,
          availability: row.availability,
        };
      }
    }

    const lines = queries.map((spec) => {
      const names = idsByName[spec.store];
      const toIds = (list: string[]) =>
        list.flatMap((name) => {
          const ids = names?.get(name);
          if (!ids) throw new Error(`${spec.id}: no offer or model "${name}" in ${spec.store}`);
          return ids;
        });
      const must = toIds(spec.must);
      const ok = toIds(spec.ok);
      const forbidden = toIds(spec.forbidden);
      const facts: Record<string, Fact> = {};
      for (const id of [...must, ...ok, ...forbidden]) {
        const fact = catalog[spec.store]?.[id];
        if (fact) facts[id] = fact;
      }
      const gold: Gold = {
        id: spec.id,
        store: spec.store,
        lang: spec.lang,
        category: spec.category,
        query: spec.query,
        must_ids: must,
        ok_ids: ok,
        forbidden_ids: forbidden,
        expected_action: spec.action,
        facts,
        ...(spec.text_any ? { text_any: spec.text_any } : {}),
        ...(spec.notes ? { notes: spec.notes } : {}),
      };
      return JSON.stringify(gold);
    });

    writeFileSync(join(dir, "gold.jsonl"), `${lines.join("\n")}\n`);
    writeFileSync(join(dir, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
    console.log(
      `gold.jsonl: ${lines.length} queries, catalog.json: ${Object.keys(catalog).join(", ")}`,
    );
  } finally {
    await handle.close();
  }
}

await main();
