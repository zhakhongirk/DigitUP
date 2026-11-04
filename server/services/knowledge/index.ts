import { and, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import type { Db, DbExecutor } from "@/db/client";
import { offers, storeNotes, type inquiries } from "@/db/schema";
import { recordAudit } from "../audit";
import { assertOwner, ServiceError, type TenantContext } from "../context";

export const NOTE_MAX_AGE_DAYS = 30;
export const NOTE_TEXT_MAX = 1000;
const DAY = 24 * 3600 * 1000;
const NOTE_LIMIT = 50;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Tells an agent how to use owner_notes without turning them into promises. */
export const OWNER_NOTES_RULE =
  "owner_notes are remarks the store owner made earlier. When one is relevant, pass it on as " +
  '"the owner said on <date>: ..." and never present it as a guarantee or a current fact; ' +
  "prices, stock and policies still come only from the other fields.";

/** What an agent receives: the owner's words and the day they were said. */
export interface AgentNote {
  text: string;
  date: string;
}

export interface OwnerNote {
  id: string;
  text: string;
  offerId: string | null;
  offerTitle: string | null;
  model: string | null;
  answeredAt: Date;
}

interface MatchedNote extends AgentNote {
  offerId: string | null;
  model: string | null;
}

export interface KnowledgeService {
  /** Every saved note, newest first, with the offer it is about. */
  list(ctx: TenantContext): Promise<OwnerNote[]>;
  remove(ctx: TenantContext, noteId: string): Promise<void>;
  /** Fresh notes that are about the given offers or their models. */
  notesForOffers(
    ctx: TenantContext,
    offerRefs: { id: string; model: string | null }[],
    now?: Date,
  ): Promise<MatchedNote[]>;
  /** Fresh notes that are not about any offer. */
  generalNotes(ctx: TenantContext, now?: Date): Promise<AgentNote[]>;
}

export function pickNotes(notes: MatchedNote[], ids: string[], model: string | null): AgentNote[] {
  return notes
    .filter(
      (n) =>
        (n.offerId !== null && ids.includes(n.offerId)) || (n.model !== null && n.model === model),
    )
    .map(({ text, date }) => ({ text, date }));
}

const dateOf = (at: Date) => at.toISOString().slice(0, 10);

/**
 * Saves or removes the store note that comes from an owner's answer. `remember` undefined leaves
 * notes alone; true replaces the note of this inquiry; false deletes it.
 */
export async function recordInquiryNote(
  tx: DbExecutor,
  ctx: TenantContext,
  inquiry: Pick<typeof inquiries.$inferSelect, "id" | "details">,
  answer: string,
  remember: boolean | undefined,
  now = new Date(),
): Promise<void> {
  if (remember === undefined) return;
  await tx
    .delete(storeNotes)
    .where(and(eq(storeNotes.tenantId, ctx.tenantId), eq(storeNotes.sourceInquiryId, inquiry.id)));
  if (!remember) return;

  const listed = inquiry.details.split("\n\nOffers:\n")[1] ?? "";
  const ids = [...new Set(listed.match(UUID) ?? [])];
  const related =
    ids.length === 0
      ? []
      : await tx
          .select({ id: offers.id, model: offers.model })
          .from(offers)
          .where(and(eq(offers.tenantId, ctx.tenantId), inArray(offers.id, ids)));
  const models = new Set(related.map((o) => o.model));
  const [onlyModel] = [...models];
  const target: { offerId: string | null; model: string | null } = { offerId: null, model: null };
  if (related.length > 0 && models.size === 1) {
    if (onlyModel) target.model = onlyModel;
    else if (related.length === 1) target.offerId = related[0]!.id;
  }
  const [note] = await tx
    .insert(storeNotes)
    .values({
      tenantId: ctx.tenantId,
      offerId: target.offerId,
      model: target.model,
      text: answer.trim().slice(0, NOTE_TEXT_MAX),
      sourceInquiryId: inquiry.id,
      answeredAt: now,
    })
    .returning({ id: storeNotes.id });
  await recordAudit(tx, ctx, {
    action: "note.saved",
    entity: "store_note",
    entityId: note!.id,
    after: { inquiryId: inquiry.id, ...target },
  });
}

export function createKnowledgeService(db: Db): KnowledgeService {
  const fresh = (ctx: TenantContext, now: Date) =>
    and(
      eq(storeNotes.tenantId, ctx.tenantId),
      gte(storeNotes.answeredAt, new Date(now.getTime() - NOTE_MAX_AGE_DAYS * DAY)),
    );

  return {
    async list(ctx) {
      assertOwner(ctx);
      const rows = await db
        .select({
          id: storeNotes.id,
          text: storeNotes.text,
          offerId: storeNotes.offerId,
          offerTitle: offers.title,
          model: storeNotes.model,
          answeredAt: storeNotes.answeredAt,
        })
        .from(storeNotes)
        .leftJoin(offers, eq(offers.id, storeNotes.offerId))
        .where(eq(storeNotes.tenantId, ctx.tenantId))
        .orderBy(desc(storeNotes.answeredAt))
        .limit(200);
      return rows;
    },

    async remove(ctx, noteId) {
      assertOwner(ctx);
      await db.transaction(async (tx) => {
        const removed = await tx
          .delete(storeNotes)
          .where(and(eq(storeNotes.id, noteId), eq(storeNotes.tenantId, ctx.tenantId)))
          .returning({ id: storeNotes.id });
        if (removed.length === 0) throw new ServiceError("not_found", "Note not found");
        await recordAudit(tx, ctx, {
          action: "note.removed",
          entity: "store_note",
          entityId: noteId,
        });
      });
    },

    async notesForOffers(ctx, offerRefs, now = new Date()) {
      const ids = offerRefs.map((o) => o.id);
      const models = [...new Set(offerRefs.flatMap((o) => (o.model ? [o.model] : [])))];
      const about = [
        ...(ids.length > 0 ? [inArray(storeNotes.offerId, ids)] : []),
        ...(models.length > 0 ? [inArray(storeNotes.model, models)] : []),
      ];
      if (about.length === 0) return [];
      const rows = await db
        .select()
        .from(storeNotes)
        .where(and(fresh(ctx, now), or(...about)))
        .orderBy(desc(storeNotes.answeredAt))
        .limit(NOTE_LIMIT);
      return rows.map((row) => ({
        text: row.text,
        date: dateOf(row.answeredAt),
        offerId: row.offerId,
        model: row.model,
      }));
    },

    async generalNotes(ctx, now = new Date()) {
      const rows = await db
        .select()
        .from(storeNotes)
        .where(and(fresh(ctx, now), isNull(storeNotes.offerId), isNull(storeNotes.model)))
        .orderBy(desc(storeNotes.answeredAt))
        .limit(NOTE_LIMIT);
      return rows.map((row) => ({ text: row.text, date: dateOf(row.answeredAt) }));
    },
  };
}
