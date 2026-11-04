import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { storeNotes } from "@/db/schema";
import { shoeStoreModel } from "@/db/seed-data/shoe-store";
import { createCustomerMcpServer } from "@/server/mcp/customer/server";
import { NOTE_MAX_AGE_DAYS } from "@/server/services/knowledge";
import { createTestTenant, testDb } from "../helpers/db";
import { connect, testServices } from "../helpers/mcp";

const services = testServices();
const db = testDb();

async function store() {
  const ctx = await createTestTenant({ actor: "customer_agent", live: true });
  await services.catalog.applyBusinessModel({ ...ctx, actor: "system" }, shoeStoreModel);
  return { ctx, owner: { ...ctx, actor: "owner" as const } };
}

async function inquiryAbout(ctx: Awaited<ReturnType<typeof store>>["ctx"], withOffer: boolean) {
  const { items } = await services.catalog.searchOffers(ctx, { query: "Nordix", limit: 1 });
  const offer = items[0]!;
  const inquiry = await services.orders.createInquiry(ctx, {
    subject: "Is it waterproof?",
    details: "Question from a shopper",
    contact: {},
    offerIds: withOffer ? [offer.id] : [],
  });
  return { inquiry, offer };
}

async function client(ctx: Awaited<ReturnType<typeof store>>["ctx"]) {
  return connect(createCustomerMcpServer({ ctx, services, source: "external_agent" }));
}

describe("owner answers as store knowledge", () => {
  it("saves a note for the offer's model and returns it from find_offers and get_offer_details", async () => {
    const { ctx, owner } = await store();
    const { inquiry, offer } = await inquiryAbout(ctx, true);
    await services.orders.answerInquiry(owner, inquiry.id, "Yes, the membrane is waterproof.", {
      remember: true,
    });

    const [note] = await db.select().from(storeNotes).where(eq(storeNotes.tenantId, ctx.tenantId));
    expect(note).toMatchObject({
      text: "Yes, the membrane is waterproof.",
      sourceInquiryId: inquiry.id,
    });
    expect(note?.offerId ?? note?.model).toBeTruthy();

    const mcp = await client(ctx);
    const found = (await mcp.call("find_offers", { intent: offer.model! })).data as {
      offers: { title: string; owner_notes?: { text: string; date: string }[] }[];
    };
    const row = found.offers.find((o) => o.title === offer.model);
    expect(row?.owner_notes).toEqual([
      {
        text: "Yes, the membrane is waterproof.",
        date: new Date().toISOString().slice(0, 10),
      },
    ]);

    const details = (await mcp.call("get_offer_details", { offer_id: offer.id })).data as {
      owner_notes?: { text: string }[];
    };
    expect(details.owner_notes?.map((n) => n.text)).toEqual(["Yes, the membrane is waterproof."]);
    await mcp.close();
  });

  it("returns a note without an offer from get_business_info only", async () => {
    const { ctx, owner } = await store();
    const { inquiry } = await inquiryAbout(ctx, false);
    await services.orders.answerInquiry(owner, inquiry.id, "We close early on Fridays.", {
      remember: true,
    });
    const mcp = await client(ctx);
    const info = (await mcp.call("get_business_info")).data as {
      owner_notes?: { text: string }[];
    };
    expect(info.owner_notes?.map((n) => n.text)).toEqual(["We close early on Fridays."]);
    const found = (await mcp.call("find_offers", { intent: "Nordix Hightop Classic" })).data as {
      offers: { owner_notes?: unknown }[];
    };
    expect(found.offers.every((o) => o.owner_notes === undefined)).toBe(true);
    await mcp.close();
  });

  it("does not save a note unless asked, and removes it when unticked later", async () => {
    const { ctx, owner } = await store();
    const { inquiry } = await inquiryAbout(ctx, false);
    await services.orders.answerInquiry(owner, inquiry.id, "Maybe.");
    expect(await services.knowledge.list(owner)).toHaveLength(0);
    await services.orders.answerInquiry(owner, inquiry.id, "Yes.", { remember: true });
    await services.orders.answerInquiry(owner, inquiry.id, "Yes, always.", { remember: true });
    expect((await services.knowledge.list(owner)).map((n) => n.text)).toEqual(["Yes, always."]);
    await services.orders.answerInquiry(owner, inquiry.id, "Yes, always.", { remember: false });
    expect(await services.knowledge.list(owner)).toHaveLength(0);
  });

  it("stops returning notes after 30 days", async () => {
    const { ctx, owner } = await store();
    const { inquiry, offer } = await inquiryAbout(ctx, true);
    await services.orders.answerInquiry(owner, inquiry.id, "Waterproof.", { remember: true });
    const general = await inquiryAbout(ctx, false);
    await services.orders.answerInquiry(owner, general.inquiry.id, "Open on holidays.", {
      remember: true,
    });

    const refs = [{ id: offer.id, model: offer.model }];
    const day = 24 * 3600 * 1000;
    const inside = new Date(Date.now() + (NOTE_MAX_AGE_DAYS - 1) * day);
    const outside = new Date(Date.now() + (NOTE_MAX_AGE_DAYS + 1) * day);
    expect(await services.knowledge.notesForOffers(ctx, refs, inside)).toHaveLength(1);
    expect(await services.knowledge.generalNotes(ctx, inside)).toHaveLength(1);
    expect(await services.knowledge.notesForOffers(ctx, refs, outside)).toHaveLength(0);
    expect(await services.knowledge.generalNotes(ctx, outside)).toHaveLength(0);
    expect(await services.knowledge.list(owner)).toHaveLength(2);
  });

  it("lets the owner delete a note and keeps notes tenant scoped", async () => {
    const { ctx, owner } = await store();
    const other = await store();
    const { inquiry } = await inquiryAbout(ctx, false);
    await services.orders.answerInquiry(owner, inquiry.id, "Free gift wrap.", { remember: true });
    const [note] = await services.knowledge.list(owner);
    await expect(services.knowledge.remove(other.owner, note!.id)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await services.knowledge.generalNotes(other.ctx)).toHaveLength(0);
    await services.knowledge.remove(owner, note!.id);
    expect(await services.knowledge.list(owner)).toHaveLength(0);
  });
});
