import { describe, expect, it, vi } from "vitest";
import { runProposal } from "@/server/agents/business/onboarding";
import { createServices } from "@/server/container";
import { handlers } from "@/server/events/handlers";
import { EVENTS } from "@/server/events/types";
import { createBusinessMcpServer } from "@/server/mcp/business/server";
import { createCustomerMcpServer } from "@/server/mcp/customer/server";
import { applyReviewEdits } from "@/server/onboarding/review";
import { loadChanges } from "@/server/owner/changes";
import { loadInbox } from "@/server/owner/inbox";
import type { TenantContext } from "@/server/services/context";
import { createProvisioningService } from "@/server/services/provisioning";
import { loadStore, searchCatalog } from "@/server/storefront/data";
import { businessModelSchema, checkLaunchReadiness } from "@/shared/business-model";
import { recordingEvents, TEST_AUTH_SECRET, testDb, uniqueSlug } from "../helpers/db";
import { connect } from "../helpers/mcp";
import { tempStorage } from "../helpers/storage";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

const events = recordingEvents();
const storage = await tempStorage();
const services = createServices({
  db: testDb(),
  events,
  authSecret: TEST_AUTH_SECRET,
  storage,
});
const provisioning = createProvisioningService({
  db: testDb(),
  events,
  defaultModel: "unconfigured",
});

const encode = (text: string) => new TextEncoder().encode(text);

const menuCsv = [
  "Name,Category,Price,Stock",
  "Flat white,Coffee,1 200 ₸,40",
  "Cardamom latte,Coffee,1 500 ₸,25",
  "Honey cake,Dessert,1 800 ₸,12",
  "Cold brew,Coffee,,8",
].join("\n");

const about = "Corner coffee bar in Almaty. Open daily 8:00 to 22:00.";

describe("owner journey", () => {
  it("takes a new business from sign-up to approved price changes", async () => {
    const email = `${uniqueSlug("owner")}@example.com`;
    const { token } = await services.tenancy.signUp({
      businessName: "Cardamom Coffee",
      email,
      password: "correct-horse",
    });
    const session = await services.tenancy.contextFromSession(token);
    expect(session).not.toBeNull();
    const owner = session!;
    expect(owner.actor).toBe("owner");

    const { assets } = await services.ingestion.addSources(owner, {
      note: about,
      files: [{ filename: "menu.csv", bytes: encode(menuCsv) }],
    });
    expect(assets.map((a) => a.kind).sort()).toEqual(["csv", "note"]);

    const uploaded = events
      .ofType(EVENTS.fileUploaded)
      .filter((e) => e.tenantId === owner.tenantId);
    expect(uploaded.length).toBeGreaterThan(0);
    for (const { sourceAssetId } of uploaded) {
      await handlers[EVENTS.fileUploaded](
        { tenantId: owner.tenantId, sourceAssetId },
        { db: testDb(), ingestion: services.ingestion },
      );
    }
    const extracted = await services.ingestion.listSourceAssets(owner, { status: "extracted" });
    expect(extracted).toHaveLength(2);

    const completed = events
      .ofType(EVENTS.ingestionCompleted)
      .filter((e) => e.tenantId === owner.tenantId);
    expect(completed).toHaveLength(1);
    const outcome = await runProposal({ services, llm: null }, completed[0]!);
    expect(outcome).toMatchObject({ status: "succeeded", by: "import" });

    const run = await services.ingestion.getLatestRun(owner);
    expect(run?.status).toBe("succeeded");
    const draft = await services.catalog.getLatestDraft(owner);
    expect(draft?.id).toBe(run?.draftId);
    const model = businessModelSchema.parse(draft!.payload);
    expect(model.offers.map((o) => o.title)).toEqual([
      "Flat white",
      "Cardamom latte",
      "Honey cake",
      "Cold brew",
    ]);
    expect(model.offers[0]).toMatchObject({ price: 1200, currency: "KZT" });
    expect(model.offers[3]).toMatchObject({ price: null, price_status: "on_request" });
    expect(checkLaunchReadiness(model).ready).toBe(false);

    const form = new FormData();
    form.set("contact.phone", "+7 701 555 01 42");
    form.set("policy.working_hours", "Daily 8:00 to 22:00");
    form.set("currency", "KZT");
    form.set("offer.3.price", "1 600");
    const edited = applyReviewEdits(model, form);
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.model.offers[3]).toMatchObject({ price: 1600, price_status: "confirmed" });
    expect(checkLaunchReadiness(edited.model).ready).toBe(true);

    const reviewed = await services.catalog.saveDraft(owner, edited.model);
    await services.catalog.confirmDraft(owner, reviewed.id);
    const confirmed = events
      .ofType(EVENTS.modelConfirmed)
      .filter((e) => e.tenantId === owner.tenantId);
    expect(confirmed).toEqual([{ tenantId: owner.tenantId, draftId: reviewed.id }]);
    await handlers[EVENTS.modelConfirmed](confirmed[0]!, { db: testDb(), provisioning });

    const tenant = await services.tenancy.getTenant(owner);
    expect(tenant.status).toBe("live");

    const store = await loadStore(services, tenant.slug);
    expect(store?.name).toBe("Cardamom Coffee");
    expect(store?.contacts.phone).toBe("+7 701 555 01 42");
    const catalog = await searchCatalog(services, store!.ctx, {});
    expect(catalog.total).toBe(4);
    const latte = catalog.items.find((item) => item.title === "Cardamom latte");
    expect(latte).toBeDefined();

    const customerCtx: TenantContext = { tenantId: owner.tenantId, actor: "customer_agent" };
    const conversation = await services.conversations.getOrCreate(customerCtx, {
      agent: "customer",
      channel: "storefront",
    });
    const customer = await connect(
      createCustomerMcpServer({
        ctx: customerCtx,
        services,
        source: "storefront",
        conversationId: conversation.id,
      }),
    );
    const idempotencyKey = `order-${uniqueSlug("k")}`;
    const items = [{ offer_id: latte!.id, quantity: 2 }];
    const contact = { name: "Aidar", phone: "+7 701 000 11 22" };

    const draftOrder = await customer.call("create_order", {
      idempotency_key: idempotencyKey,
      items,
      contact,
    });
    expect(draftOrder.isError).toBe(false);
    const draftData = draftOrder.data as { order_id: string; status: string };
    expect(draftData.status).toBe("draft");

    const submittedOrder = await customer.call("create_order", {
      idempotency_key: idempotencyKey,
      items,
      contact,
      submit: true,
    });
    const orderData = submittedOrder.data as { order_id: string; status: string };
    expect(orderData).toMatchObject({ order_id: draftData.order_id, status: "submitted" });

    const inquiryCall = await customer.call("submit_inquiry", {
      subject: "Do you have oat milk?",
      details: "Looking for a vegan latte",
      contact: { email: "dana@example.com" },
    });
    expect(inquiryCall.isError).toBe(false);
    const inquiryId = (inquiryCall.data as { inquiry_id: string }).inquiry_id;
    await customer.close();

    const inbox = await loadInbox(services, owner, { filter: "all" });
    expect(inbox.counts).toMatchObject({ all: 2, new: 2, in_progress: 0, completed: 0 });
    const orderItem = inbox.items.find((i) => i.id === orderData.order_id);
    const inquiryItem = inbox.items.find((i) => i.id === inquiryId);
    expect(orderItem).toMatchObject({ kind: "order", bucket: "new", who: "Aidar" });
    expect(orderItem?.preview).toContain("Cardamom latte");
    expect(inquiryItem).toMatchObject({ kind: "inquiry", bucket: "new", who: "dana@example.com" });
    expect(inquiryItem?.source).toBe("Storefront chat");

    const newOnly = await loadInbox(services, owner, { filter: "new" });
    expect(newOnly.items).toHaveLength(2);

    for (const status of ["received", "processing"] as const) {
      await services.orders.updateOrderStatus(owner, orderData.order_id, status);
      const view = await loadInbox(services, owner, {
        filter: "in_progress",
        selected: `order:${orderData.order_id}`,
      });
      expect(view.selected).toMatchObject({ kind: "order", status, bucket: "in_progress" });
    }
    await services.orders.updateOrderStatus(owner, orderData.order_id, "completed");
    const done = await loadInbox(services, owner, { filter: "completed" });
    expect(done.items.map((i) => i.id)).toEqual([orderData.order_id]);
    expect(done.counts).toMatchObject({ new: 1, in_progress: 0, completed: 1 });

    const trail = await services.audit.list(owner, {
      entity: "order",
      entityId: orderData.order_id,
    });
    const transitions = trail
      .filter((e) => e.action === "order.status_changed")
      .map((e) => (e.after as { status: string }).status)
      .reverse();
    expect(transitions).toEqual(["received", "processing", "completed"]);

    const agent = await connect(
      createBusinessMcpServer({
        ctx: { tenantId: owner.tenantId, actor: "business_agent" },
        services,
      }),
    );
    const created = await agent.call("update_prices", {
      items: [{ offer_id: latte!.id, price: 1800 }],
      reason: "Cardamom prices went up",
    });
    await agent.close();
    expect(created.isError).toBe(false);
    const changeSetId = (created.data as { change_set_id: string }).change_set_id;

    const pending = await loadChanges(services, owner);
    expect(pending.list).toEqual([
      expect.objectContaining({ id: changeSetId, status: "pending", summary: "1 price changed" }),
    ]);
    expect(pending.selected).toMatchObject({
      id: changeSetId,
      requestedBy: "Business Agent",
      reason: "Cardamom prices went up",
    });
    const row = pending.selected?.groups[0]?.rows[0];
    expect(row).toMatchObject({ title: "Cardamom latte", delta: "+20.0%", flagged: true });
    expect((await services.catalog.getOffer(owner, latte!.id))?.price).toBe(1500);

    await services.approvals.approveChangeSet(owner, changeSetId);
    expect((await services.catalog.getOffer(owner, latte!.id))?.price).toBe(1800);
    const after = await searchCatalog(services, store!.ctx, { query: "latte" });
    expect(after.items[0]?.title).toBe("Cardamom latte");
    expect(after.items[0]?.priceLabel).toContain("1 800");
    const resolved = await loadChanges(services, owner, changeSetId);
    expect(resolved.selected?.status).toBe("applied");
  });
});
