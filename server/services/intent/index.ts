import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gte, isNotNull, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db/client";
import { intentEvents } from "@/db/schema";
import type { TextLang } from "@/shared/text-lang";
import { recordAudit } from "../audit";
import type { CatalogService } from "../catalog";
import { ServiceError, type TenantContext } from "../context";
import { planIntent } from "./plan";
import { planRewrite, type IntentInterpreter } from "./rewrite";
import { executePlan, type Execution, type IntentResult, type SearchArguments } from "./resolve";
import { backfillVocabularies, loadVocabulary, refreshVocabulary } from "./store";
import { summarize } from "./summary";
import type { StoreVocabulary } from "./vocabulary";

export * from "./resolve";
export * from "./sizes";
export type { Plan } from "./plan";
export { planIntent } from "./plan";
export {
  createModelInterpreter,
  rewriteSchema,
  type IntentInterpreter,
  type Rewrite,
} from "./rewrite";
export { deriveVocabulary, type StoreVocabulary } from "./vocabulary";

export const VERDICTS = ["ok", "wrong", "incomplete"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const RAW_TOOLS = [
  "search_offers",
  "get_offer_details",
  "check_availability",
  "compare_offers",
] as const;
export type RawTool = (typeof RAW_TOOLS)[number];

export interface IntentTracking {
  channel: "storefront" | "external_agent";
  sessionKey?: string;
  /** Caller identity when no session id is given, for example an IP and store pair. */
  clientKey?: string;
}

export interface ResolveInput {
  text: string;
  lang?: TextLang;
  sessionKey?: string;
  track?: IntentTracking;
}

export interface IntentStats {
  findOffers: number;
  reported: number;
  wrong: number;
  incomplete: number;
  followedByRaw: number;
}

export interface IntentService {
  resolveIntent(ctx: TenantContext, input: ResolveInput): Promise<IntentResult>;
  getVocabulary(ctx: TenantContext): Promise<StoreVocabulary>;
  rebuildVocabulary(ctx: TenantContext): Promise<StoreVocabulary>;
  /** Builds the vocabulary of every store that has none yet. */
  backfillVocabularies(): Promise<number>;
  /** Notes a raw tool call that came after a find_offers call from the same caller. */
  recordRawCall(
    ctx: TenantContext,
    call: { tool: RawTool; args: unknown; resultIds: string[]; track: IntentTracking },
  ): Promise<string | null>;
  reportAnswer(
    ctx: TenantContext,
    report: { intentId: string; verdict: Verdict; comment?: string },
  ): Promise<{ intentId: string; verdict: Verdict }>;
  stats(ctx: TenantContext, options?: { days?: number; now?: Date }): Promise<IntentStats>;
}

const TEXT_LIMIT = 500;
const LINK_WINDOW_MS = 20 * 60 * 1000;
const DAY = 24 * 3600 * 1000;

export function createIntentService({
  db,
  catalog,
  interpret,
}: {
  db: Db;
  catalog: Pick<CatalogService, "searchOffers" | "recordSearchMiss">;
  /** Tried once when the deterministic plan leaves words unresolved or finds nothing. */
  interpret?: IntentInterpreter;
}): IntentService {
  return {
    async resolveIntent(ctx, input) {
      const text = input.text.trim().slice(0, 1000);
      const vocabulary = await loadVocabulary(db, ctx.tenantId);
      const plan = planIntent(text, vocabulary, input.lang);
      const search = (args: SearchArguments) =>
        catalog.searchOffers(ctx, {
          query: args.query,
          category: args.category,
          attributes: args.attributes,
          attributesAny: args.attributes_any,
          minPrice: args.min_price,
          maxPrice: args.max_price,
          limit: args.limit,
          offset: args.offset,
        });
      let execution: Execution = await executePlan(plan, search);
      let interpretedBy: IntentResult["interpretedBy"];

      const found = (e: Execution) => e.total + e.onRequestTotal;
      const needsReading =
        found(execution) === 0 || execution.unresolved.some((u) => u.startsWith("unknown word"));
      if (interpret && text && needsReading) {
        const rewrite = await interpret(ctx, { text, lang: input.lang, vocabulary });
        if (rewrite) {
          const second = await executePlan(
            planRewrite(plan, rewrite, vocabulary, input.lang),
            search,
          );
          const better =
            found(second) > found(execution) ||
            (found(second) > 0 &&
              found(second) === found(execution) &&
              second.unresolved.length < execution.unresolved.length);
          if (better) {
            execution = second;
            interpretedBy = "fast_model";
          }
        }
      }
      const result: IntentResult = {
        ...execution,
        ...(interpretedBy ? { interpretedBy } : {}),
        intentId: randomUUID(),
        summary: summarize(execution),
      };

      if (execution.total + execution.onRequestTotal === 0 && text) {
        await catalog.recordSearchMiss(ctx, text);
      }
      if (input.track) {
        await db.insert(intentEvents).values({
          id: result.intentId,
          tenantId: ctx.tenantId,
          kind: "find_offers",
          channel: input.track.channel,
          sessionKey: input.sessionKey ?? input.track.sessionKey ?? null,
          clientKey: input.track.clientKey ?? null,
          text: text.slice(0, TEXT_LIMIT),
          applied: result.applied,
          relaxed: result.relaxed,
          resultIds: [...result.offers, ...result.onRequest].map((m) => m.offer.id),
        });
      }
      return result;
    },

    getVocabulary: (ctx) => loadVocabulary(db, ctx.tenantId),

    rebuildVocabulary: (ctx) => refreshVocabulary(db, ctx.tenantId),

    backfillVocabularies: () => backfillVocabularies(db),

    async recordRawCall(ctx, { tool, args, resultIds, track }) {
      const identities: SQL[] = [];
      if (track.sessionKey) identities.push(eq(intentEvents.sessionKey, track.sessionKey));
      if (track.clientKey) identities.push(eq(intentEvents.clientKey, track.clientKey));
      if (identities.length === 0) return null;
      const [previous] = await db
        .select({ id: intentEvents.id })
        .from(intentEvents)
        .where(
          and(
            eq(intentEvents.tenantId, ctx.tenantId),
            eq(intentEvents.kind, "find_offers"),
            gte(intentEvents.createdAt, new Date(Date.now() - LINK_WINDOW_MS)),
            or(...identities),
          ),
        )
        .orderBy(desc(intentEvents.createdAt))
        .limit(1);
      if (!previous) return null;
      const [row] = await db
        .insert(intentEvents)
        .values({
          tenantId: ctx.tenantId,
          kind: tool,
          channel: track.channel,
          sessionKey: track.sessionKey ?? null,
          clientKey: track.clientKey ?? null,
          text: JSON.stringify(args).slice(0, TEXT_LIMIT),
          applied: args as Record<string, unknown>,
          resultIds,
          afterIntentId: previous.id,
        })
        .returning({ id: intentEvents.id });
      return row?.id ?? null;
    },

    async reportAnswer(ctx, { intentId, verdict, comment }) {
      return db.transaction(async (tx) => {
        const [event] = await tx
          .select({ id: intentEvents.id, verdict: intentEvents.verdict })
          .from(intentEvents)
          .where(
            and(
              eq(intentEvents.id, intentId),
              eq(intentEvents.tenantId, ctx.tenantId),
              eq(intentEvents.kind, "find_offers"),
            ),
          )
          .for("update");
        if (!event) throw new ServiceError("not_found", "Unknown intent_id");
        const note = comment?.trim().slice(0, TEXT_LIMIT) || null;
        await tx
          .update(intentEvents)
          .set({ verdict, comment: note })
          .where(eq(intentEvents.id, intentId));
        await recordAudit(tx, ctx, {
          action: "intent.reported",
          entity: "intent_event",
          entityId: intentId,
          before: { verdict: event.verdict },
          after: { verdict, comment: note },
        });
        return { intentId, verdict };
      });
    },

    async stats(ctx, options = {}) {
      const since = new Date((options.now ?? new Date()).getTime() - (options.days ?? 30) * DAY);
      const mine = and(eq(intentEvents.tenantId, ctx.tenantId), gte(intentEvents.createdAt, since));
      const [finds] = await db
        .select({
          total: count(),
          reported: sql<number>`count(*) filter (where ${isNotNull(intentEvents.verdict)})::int`,
          wrong: sql<number>`count(*) filter (where ${intentEvents.verdict} = 'wrong')::int`,
          incomplete: sql<number>`count(*) filter (where ${intentEvents.verdict} = 'incomplete')::int`,
        })
        .from(intentEvents)
        .where(and(mine, eq(intentEvents.kind, "find_offers")));
      const [raw] = await db
        .select({ followed: sql<number>`count(distinct ${intentEvents.afterIntentId})::int` })
        .from(intentEvents)
        .where(and(mine, eq(intentEvents.kind, "search_offers")));
      return {
        findOffers: finds?.total ?? 0,
        reported: finds?.reported ?? 0,
        wrong: finds?.wrong ?? 0,
        incomplete: finds?.incomplete ?? 0,
        followedByRaw: raw?.followed ?? 0,
      };
    },
  };
}
