import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerInquiry, decideChangeSet, signOut, updateStatus } from "@/app/app/actions";
import {
  expectRedirect,
  form,
  resetSession,
  revalidate,
  seedShop,
  session,
  signUpOwner,
  testServices,
} from "./harness";

vi.mock("next/headers", async () => (await import("./harness")).headersMock());
vi.mock("next/cache", async () => (await import("./harness")).cacheMock());
vi.mock("next/navigation", async () => (await import("./harness")).navigationMock());
vi.mock("@/server/container", async () => (await import("./harness")).containerMock());

const prev = { error: null };
const ZERO_ID = "00000000-0000-4000-8000-000000000000";

async function ownerWithOrder() {
  const { ctx, token } = await signUpOwner();
  const ids = await seedShop(ctx);
  const { orders } = testServices();
  const { order } = await orders.createOrder(ctx, {
    idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
    source: "storefront",
    items: [{ offerId: ids.Alpha!, quantity: 1 }],
  });
  await orders.submitOrder(ctx, order.id);
  const inquiry = await orders.createInquiry(ctx, { subject: "Do you deliver?" });
  session.token = token;
  return { ctx, token, order, inquiry, ids };
}

beforeEach(resetSession);

describe("updateStatus", () => {
  it("redirects to sign-in without a session", async () => {
    await expectRedirect(
      updateStatus(prev, form({ kind: "order", id: "x", status: "received" })),
      "/signin?next=/app/inbox",
    );
  });

  it("updates an order status", async () => {
    const { ctx, order } = await ownerWithOrder();
    const result = await updateStatus(
      prev,
      form({ kind: "order", id: order.id, status: "received" }),
    );
    expect(result).toEqual({ error: null });
    expect((await testServices().orders.getOrder(ctx, order.id))?.status).toBe("received");
    expect(revalidate).toHaveBeenCalledWith("/app", "layout");
  });

  it("updates an inquiry status", async () => {
    const { ctx, inquiry } = await ownerWithOrder();
    const result = await updateStatus(
      prev,
      form({ kind: "inquiry", id: inquiry.id, status: "in_progress" }),
    );
    expect(result).toEqual({ error: null });
    expect((await testServices().orders.getInquiry(ctx, inquiry.id))?.status).toBe("in_progress");
  });

  it("rejects unknown statuses without touching the record", async () => {
    const { ctx, order, inquiry } = await ownerWithOrder();
    expect(
      await updateStatus(prev, form({ kind: "order", id: order.id, status: "bogus" })),
    ).toEqual({ error: "Unknown order status." });
    expect(
      await updateStatus(prev, form({ kind: "inquiry", id: inquiry.id, status: "received" })),
    ).toEqual({ error: "Unknown status." });
    expect((await testServices().orders.getOrder(ctx, order.id))?.status).toBe("submitted");
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("rejects a missing id or an unknown kind", async () => {
    await ownerWithOrder();
    expect(await updateStatus(prev, form({ kind: "order", status: "received" }))).toEqual({
      error: "Nothing selected.",
    });
    expect(
      await updateStatus(prev, form({ kind: "refund", id: ZERO_ID, status: "received" })),
    ).toEqual({ error: "Nothing selected." });
  });

  it("returns the service error for a disallowed transition", async () => {
    const { ctx, order } = await ownerWithOrder();
    const result = await updateStatus(
      prev,
      form({ kind: "order", id: order.id, status: "completed" }),
    );
    expect(result.error).toEqual(expect.any(String));
    expect((await testServices().orders.getOrder(ctx, order.id))?.status).toBe("submitted");
  });

  it("cannot touch another tenant's order or inquiry", async () => {
    const other = await ownerWithOrder();
    const mine = await ownerWithOrder();
    session.token = mine.token;
    const orderResult = await updateStatus(
      prev,
      form({ kind: "order", id: other.order.id, status: "received" }),
    );
    const inquiryResult = await updateStatus(
      prev,
      form({ kind: "inquiry", id: other.inquiry.id, status: "completed" }),
    );
    expect(orderResult.error).toEqual(expect.any(String));
    expect(inquiryResult.error).toEqual(expect.any(String));
    const { orders } = testServices();
    expect((await orders.getOrder(other.ctx, other.order.id))?.status).toBe("submitted");
    expect((await orders.getInquiry(other.ctx, other.inquiry.id))?.status).toBe("new");
  });
});

describe("non-uuid ids", () => {
  it("are reported as not found without reaching the services", async () => {
    await ownerWithOrder();
    expect(
      await updateStatus(prev, form({ kind: "order", id: "abc", status: "received" })),
    ).toEqual({ error: "Not found." });
    expect(await answerInquiry(prev, form({ id: "abc", answer: "Yes" }))).toEqual({
      error: "Not found.",
    });
    expect(await decideChangeSet(prev, form({ id: "abc", decision: "approve" }))).toEqual({
      error: "Not found.",
    });
  });
});

describe("decideChangeSet", () => {
  async function pendingChange() {
    const owner = await ownerWithOrder();
    const changeSet = await testServices().approvals.createChangeSet(
      { ...owner.ctx, actor: "business_agent" },
      { ops: [{ op: "update_prices", items: [{ offerId: owner.ids.Alpha!, price: 150 }] }] },
    );
    return { ...owner, changeSet };
  }

  it("redirects to sign-in without a session", async () => {
    await expectRedirect(
      decideChangeSet(prev, form({ id: "x", decision: "approve" })),
      "/signin?next=/app/approvals",
    );
  });

  it("approves and applies a change set", async () => {
    const { ctx, changeSet, ids } = await pendingChange();
    const result = await decideChangeSet(prev, form({ id: changeSet.id, decision: "approve" }));
    expect(result).toEqual({ error: null });
    const { approvals, catalog } = testServices();
    expect((await approvals.getChangeSet(ctx, changeSet.id))?.status).toBe("applied");
    expect((await catalog.getOffer(ctx, ids.Alpha!))?.price).toBe(150);
    expect(revalidate).toHaveBeenCalledWith("/app", "layout");
  });

  it("rejects a change set without applying it", async () => {
    const { ctx, changeSet, ids } = await pendingChange();
    const result = await decideChangeSet(prev, form({ id: changeSet.id, decision: "reject" }));
    expect(result).toEqual({ error: null });
    const { approvals, catalog } = testServices();
    expect((await approvals.getChangeSet(ctx, changeSet.id))?.status).toBe("rejected");
    expect((await catalog.getOffer(ctx, ids.Alpha!))?.price).toBe(100);
  });

  it("rejects an invalid decision and a missing id", async () => {
    const { ctx, changeSet } = await pendingChange();
    expect(await decideChangeSet(prev, form({ id: changeSet.id, decision: "maybe" }))).toEqual({
      error: "Choose approve or reject.",
    });
    expect(await decideChangeSet(prev, form({ decision: "approve" }))).toEqual({
      error: "Nothing selected.",
    });
    expect((await testServices().approvals.getChangeSet(ctx, changeSet.id))?.status).toBe(
      "pending",
    );
  });

  it("returns an error when deciding twice or for another tenant", async () => {
    const other = await pendingChange();
    const mine = await pendingChange();
    session.token = mine.token;
    const foreign = await decideChangeSet(
      prev,
      form({ id: other.changeSet.id, decision: "approve" }),
    );
    expect(foreign.error).toEqual(expect.any(String));
    const { approvals } = testServices();
    expect((await approvals.getChangeSet(other.ctx, other.changeSet.id))?.status).toBe("pending");
    await decideChangeSet(prev, form({ id: mine.changeSet.id, decision: "approve" }));
    const again = await decideChangeSet(prev, form({ id: mine.changeSet.id, decision: "reject" }));
    expect(again.error).toEqual(expect.any(String));
  });
});

describe("signOut", () => {
  it("clears the session cookie and redirects to sign-in", async () => {
    const { token } = await signUpOwner();
    session.token = token;
    await expectRedirect(signOut(), "/signin");
    expect(session.cleared).toBe(true);
    expect(session.token).toBeNull();
  });

  it("leaves the session valid for other devices", async () => {
    const { token } = await signUpOwner();
    session.token = token;
    await expectRedirect(signOut(), "/signin");
    expect(await testServices().tenancy.contextFromSession(token)).not.toBeNull();
  });
});
