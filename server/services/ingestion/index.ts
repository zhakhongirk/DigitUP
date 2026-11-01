import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { sourceAssets } from "@/db/schema";
import type { TenantContext } from "../context";

export type SourceAsset = typeof sourceAssets.$inferSelect;

export interface IngestionService {
  listSourceAssets(
    ctx: TenantContext,
    filter?: { status?: SourceAsset["status"]; limit?: number },
  ): Promise<SourceAsset[]>;
}

export function createIngestionService(db: Db): IngestionService {
  return {
    async listSourceAssets(ctx, filter = {}) {
      const conditions = [eq(sourceAssets.tenantId, ctx.tenantId)];
      if (filter.status) conditions.push(eq(sourceAssets.status, filter.status));
      return db
        .select()
        .from(sourceAssets)
        .where(and(...conditions))
        .orderBy(desc(sourceAssets.createdAt))
        .limit(Math.min(Math.max(filter.limit ?? 50, 1), 200));
    },
  };
}
