import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gte, isNotNull, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db/client";
import { intentEvents } from "@/db/schema";
import type { TextLang } from "@/shared/text-lang";
import { recordAudit } from "../audit";
import { buildGroups, type CatalogService, type OfferView } from "../catalog";
import { ServiceError, type TenantContext } from "../context";
import { planIntent, type Plan } from "./plan";
import { log } from "@/server/log";
import { planRewrite, type IntentInterpreter, type Rewrite } from "./rewrite";
import {
  executePlan,
  mergeLinked,
  type Execution,
  type IntentResult,
  type SearchArguments,
} from "./resolve";
import { createManualService, linksFor, loadManual, type ManualService } from "./manual";
import { backfillVocabularies, loadVocabulary, refreshVocabulary } from "./store";
import { summarize } from "./summary";
import type { StoreVocabulary } from "./vocabulary";

export * from "./resolve";
export * from "./sizes";
export { termMatches, type LinkedTerm, type LinkTarget } from "./manual";
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
  /** Hold back the miss count, the event row and the rewrite until `commitResolved` is called. */
  defer?: boolean;
}

export interface IntentStats {
  findOffers: number;
  reported: number;
  wrong: number;
  incomplete: number;
  followedByRaw: number;
}

export interface IntentService extends ManualService {
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
  /** Records a result that was resolved with `defer`; does nothing for any other result. */
  commitResolved(result: IntentResult): Promise<void>;
  /** Resolves once the background rewrites started so far have been logged. */
  settled(): Promise<void>;
}

/** One id per product: the variant a card for the group would lead with. */
function leadIds(offers: OfferView[]): string[] {
  return buildGroups(offers).map((group) => group.lead.id);
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
  catalog: Pick<CatalogService, "searchOffers" | "recordSearchMiss" | "getOffers" | "listVariants">;
  /**
   * Tried once after the answer is sent when the deterministic plan leaves words unresolved or
   * finds nothing; its reading is logged on the intent event and never delays the answer.
   */
  interpret?: IntentInterpreter;
}): IntentService {
  const background = new Set<Promise<void>>();
  const deferred = new WeakMap<IntentResult, () => Promise<void>>();
  const manual = createManualService(db);

  async function linkedOffers(ctx: TenantContext, text: string): Promise<OfferView[]> {
    const links = linksFor(await loadManual(db, ctx.tenantId), text);
    if (links.length === 0) return [];
    const ids = [...new Set(links.flatMap((l) => l.offerIds))];
    const models = [...new Set(links.flatMap((l) => l.models))];
    const [byId, byModel] = await Promise.all([
      ids.length > 0 ? catalog.getOffers(ctx, ids) : [],
      models.length > 0 ? catalog.listVariants(ctx, models) : [],
    ]);
    const unique = new Map<string, OfferView>();
    for (const offer of [...byId, ...byModel]) {
      if (offer.status === "active") unique.set(offer.id, offer);
    }
    return [...unique.values()];
  }

  function logRewrite(task: {
    ctx: TenantContext;
    intentId: string;
    text: string;
    lang?: TextLang;
    vocabulary: StoreVocabulary;
    plan: Plan;
    baseline: Execution;
    search: (args: SearchArguments) => ReturnType<CatalogService["searchOffers"]>;
  }): void {
    if (!interpret) return;
    const { ctx, intentId, text, lang, vocabulary, plan, baseline, search } = task;
    const run = (async () => {
      const startedAt = Date.now();
      let reading: Rewrite | null = null;
      let found = 0;
      try {
        reading = await interpret(ctx, { text, lang, vocabulary });
        if (reading) {
          const second = await executePlan(planRewrite(plan, reading, vocabulary, lang), search);
          found = second.total + second.onRequestTotal;
        }
      } catch (error) {
        log.warn("intent.rewrite_failed", { error });
      }
      const before = baseline.total + baseline.onRequestTotal;
      await db
        .update(intentEvents)
        .set({
          rewrite: {
            reading,
            ms: Date.now() - startedAt,
            foundBefore: before,
            foundAfter: found,
            better: reading !== null && found > before,
          },
        })
        .where(eq(intentEvents.id, intentId));
    })()
      .catch((error: unknown) => log.warn("intent.rewrite_log_failed", { error }))
      .finally(() => background.delete(run));
    background.add(run);
  }

  return {
    ...manual,

    async settled() {
      while (background.size > 0) await Promise.all([...background]);
    },

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
      const linked = await linkedOffers(ctx, text);
      const execution: Execution = mergeLinked(await executePlan(plan, search), linked);

      const found = (e: Execution) => e.total + e.onRequestTotal;
      const needsReading =
        found(execution) === 0 ||
        (linked.length === 0 && execution.unresolved.some((u) => u.startsWith("unknown word")));
      const result: IntentResult = {
        ...execution,
        intentId: randomUUID(),
        summary: summarize(execution),
      };

      const record = async () => {
        if (execution.total + execution.onRequestTotal === 0 && text) {
          await catalog.recordSearchMiss(ctx, text);
        }
        if (!input.track) return;
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
          resultIds: leadIds([...result.offers, ...result.onRequest].map((m) => m.offer)),
        });
        if (interpret && needsReading) {
          logRewrite({
            ctx,
            intentId: result.intentId,
            text,
            lang: input.lang,
            vocabulary,
            plan,
            baseline: execution,
            search,
          });
        }
      };
      if (input.defer) deferred.set(result, record);
      else await record();
      return result;
    },

    async commitResolved(result) {
      const record = deferred.get(result);
      if (!record) return;
      deferred.delete(result);
      await record();
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
