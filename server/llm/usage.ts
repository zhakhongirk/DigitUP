import type { Db } from "@/db/client";
import { llmUsage } from "@/db/schema";
import type { LlmUsageRecord } from "./types";

export function createUsageRecorder(db: () => Db) {
  return async (record: LlmUsageRecord): Promise<void> => {
    await db()
      .insert(llmUsage)
      .values({
        tenantId: record.tenantId,
        apiKeyId: record.apiKeyId ?? null,
        surface: record.surface,
        model: record.model,
        tier: record.tier ?? "main",
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        cachedTokens: record.cachedTokens,
      });
  };
}
