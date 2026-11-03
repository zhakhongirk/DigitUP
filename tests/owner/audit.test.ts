import { describe, expect, it, vi } from "vitest";
import type { Services } from "@/server/container";
import { ACTOR_LABELS, actionLabel, auditChange, resolveAuditTargets } from "@/server/owner/audit";
import type { TenantContext } from "@/server/services/context";

describe("ACTOR_LABELS", () => {
  it("labels every actor", () => {
    expect(ACTOR_LABELS).toEqual({
      owner: "You",
      business_agent: "Business Agent",
      customer_agent: "Customer Agent",
      system: "System",
    });
  });
});

describe("actionLabel", () => {
  it.each([
    ["api_key.created", "Created an API key"],
    ["api_key.revoked", "Revoked an API key"],
    ["business_model.applied", "Published the business model"],
    ["business_model.confirmed", "Confirmed the business model"],
    ["business_model.proposed", "Proposed a business model"],
    ["change_set.applied", "Approved changes"],
    ["change_set.created", "Requested an approval"],
    ["change_set.rejected", "Rejected changes"],
    ["conversation.created", "Started a conversation"],
    ["conversation.status_changed", "Changed a conversation status"],
    ["inquiry.answered", "Answered a question"],
    ["inquiry.created", "Sent a question to the owner"],
    ["inquiry.status_changed", "Changed a question status"],
    ["offer.archived", "Archived an offer"],
    ["offer.created", "Added an offer"],
    ["offer.price_updated", "Changed a price"],
    ["offer.updated", "Edited an offer"],
    ["order.created", "Drafted an order"],
    ["order.status_changed", "Changed an order status"],
    ["order.contact_updated", "Updated order details"],
    ["order.submitted", "Order confirmed by the buyer"],
    ["policies.updated", "Updated store policies"],
    ["profile.updated", "Updated store profile"],
    ["user.password_changed", "Changed the password"],
    ["user.sessions_revoked", "Signed out everywhere"],
    ["proposal_run.started", "Started analysing the uploaded files"],
    ["source_asset.uploaded", "Uploaded a file"],
    ["tenant.created", "Created the store"],
    ["tenant.provisioned", "Launched the store"],
    ["tenant.status_changed", "Changed the store status"],
    ["user.created", "Created the owner account"],
  ])("labels %s", (action, label) => {
    expect(actionLabel(action)).toBe(label);
  });

  it("falls back to the raw action for unknown actions", () => {
    expect(actionLabel("widget.exploded")).toBe("widget.exploded");
  });
});

describe("auditChange", () => {
  it("describes a status change as before → after with underscores spaced", () => {
    expect(
      auditChange({
        before: { status: "pending_review" },
        after: { status: "approved" },
      }),
    ).toBe("pending review → approved");
  });

  it("returns an empty string when the status does not change", () => {
    expect(auditChange({ before: { status: "open" }, after: { status: "open", note: "x" } })).toBe(
      "",
    );
  });

  it("returns an empty string for changes without a status", () => {
    expect(auditChange({ before: { price: 1 }, after: { price: 2 } })).toBe("");
  });

  it("returns an empty string when either side is missing or not an object", () => {
    expect(auditChange({ before: null, after: { status: "open" } })).toBe("");
    expect(auditChange({ before: { status: "open" }, after: null })).toBe("");
    expect(auditChange({ before: "open", after: "closed" })).toBe("");
  });

  it("ignores a non-string status", () => {
    expect(auditChange({ before: { status: 1 }, after: { status: 2 } })).toBe("");
  });
});

describe("resolveAuditTargets", () => {
  const OFFER = "00000000-0000-4000-8000-000000000001";
  const CS = "00000000-0000-4000-8000-000000000002";
  const ORDER = "9ad11a00-0000-4000-8000-000000000003";
  const ctx = {} as TenantContext;

  function event(id: string, entity: string, entityId: string | null, extra = {}) {
    return { id, entity, entityId, before: null, after: null, ...extra };
  }

  it("names items with one batched lookup per entity type", async () => {
    const getOffers = vi.fn(async () => [{ id: OFFER, title: "Nordix Air Street Sneakers" }]);
    const listChangeSets = vi.fn(async () => [
      { id: CS, ops: [{ op: "update_prices", items: [{ offerId: OFFER, price: 1 }] }] },
    ]);
    const services = {
      catalog: { getOffers },
      approvals: { listChangeSets },
    } as unknown as Services;

    const targets = await resolveAuditTargets(services, ctx, [
      event("a", "offer", OFFER),
      event("b", "offer", OFFER),
      event("c", "change_set", CS),
      event("d", "change_set", CS),
      event("e", "order", ORDER),
      event("f", "inquiry", OFFER, { after: { subject: "Price?" } }),
    ]);

    expect(getOffers).toHaveBeenCalledTimes(1);
    expect(listChangeSets).toHaveBeenCalledTimes(1);
    expect(targets.get("a")).toEqual({
      name: "Nordix Air Street Sneakers",
      href: `/app/catalog?status=all&offer=${OFFER}`,
    });
    expect(targets.get("c")).toEqual({
      name: "1 price changed",
      href: `/app/approvals?id=${CS}`,
    });
    expect(targets.get("e")).toEqual({
      name: "Order 9AD11A",
      href: `/app/inbox?item=order%3A${ORDER}`,
    });
    expect(targets.get("f")?.name).toBe("Question: Price?");
  });

  it("skips lookups when no event needs them and falls back to stored titles", async () => {
    const getOffers = vi.fn(async () => []);
    const listChangeSets = vi.fn(async () => []);
    const services = {
      catalog: { getOffers },
      approvals: { listChangeSets },
    } as unknown as Services;

    const none = await resolveAuditTargets(services, ctx, [event("a", "tenant", "t")]);
    expect(none.size).toBe(0);
    expect(getOffers).not.toHaveBeenCalled();
    expect(listChangeSets).not.toHaveBeenCalled();

    const gone = await resolveAuditTargets(services, ctx, [
      event("b", "offer", OFFER, { before: { title: "Old boots" } }),
    ]);
    expect(gone.get("b")).toEqual({ name: "Old boots", href: null });
  });
});
