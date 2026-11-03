import { describe, expect, it } from "vitest";
import {
  activityRow,
  buildSetup,
  changeHref,
  healthFromStats,
  inboxBreakdown,
  inboxHref,
} from "@/server/owner/workspace";
import type { AuditEvent } from "@/server/services/audit";

describe("healthFromStats", () => {
  it("maps catalog stats to the health card", () => {
    const health = healthFromStats({
      byStatus: { active: 4, draft: 2, archived: 1 },
      priceOnRequest: 3,
      availabilityUnknown: 2,
    });
    expect(health).toEqual({ active: 4, priceOnRequest: 3, stockUnknown: 2 });
  });

  it("is all zeros for an empty catalog", () => {
    const health = healthFromStats({
      byStatus: { active: 0, draft: 0, archived: 0 },
      priceOnRequest: 0,
      availabilityUnknown: 0,
    });
    expect(health).toEqual({ active: 0, priceOnRequest: 0, stockUnknown: 0 });
  });
});

describe("inboxBreakdown", () => {
  it("pluralizes and skips empty parts", () => {
    expect(inboxBreakdown(2, 1)).toBe("2 orders, 1 question");
    expect(inboxBreakdown(1, 0)).toBe("1 order");
    expect(inboxBreakdown(0, 3)).toBe("3 questions");
    expect(inboxBreakdown(0, 0)).toBe("");
  });
});

describe("links", () => {
  it("builds inbox and change set links", () => {
    expect(inboxHref({ key: "order:abc" })).toBe("/app/inbox?item=order%3Aabc");
    expect(changeHref("cs-1")).toBe("/app/changes?id=cs-1");
  });
});

describe("activityRow", () => {
  it("labels the action and status change", () => {
    const event = {
      id: "e1",
      actor: "owner",
      action: "order.status_changed",
      before: { status: "submitted" },
      after: { status: "received" },
      createdAt: new Date("2026-11-02T09:00:00Z"),
    } as AuditEvent;
    expect(activityRow(event)).toMatchObject({
      actor: "owner",
      what: "Changed an order status",
      change: "submitted → received",
    });
  });
});

describe("buildSetup", () => {
  const base = {
    slug: "shoes",
    contacts: {},
    policies: {},
    health: { active: 5, priceOnRequest: 2, stockUnknown: 0 },
    activeKeys: 0,
    chatted: false,
  };
  const state = (input: Parameters<typeof buildSetup>[0]) =>
    Object.fromEntries(buildSetup(input).map((i) => [i.key, i.done]));

  it("starts with only unfinished work", () => {
    expect(state(base)).toEqual({
      contacts: false,
      prices: false,
      share: false,
      chat: false,
      agents: false,
    });
  });

  it("marks items done from real data", () => {
    const done = state({
      ...base,
      contacts: { phone: "+7 700 000 00 00" },
      policies: { working_hours: "Daily 10:00-20:00" },
      health: { active: 5, priceOnRequest: 0, stockUnknown: 0 },
      activeKeys: 1,
      chatted: true,
    });
    expect(done).toMatchObject({ contacts: true, prices: true, chat: true, agents: true });
  });

  it("links the storefront with a copyable path", () => {
    const share = buildSetup(base).find((i) => i.key === "share");
    expect(share).toMatchObject({ href: "/s/shoes", copy: "/s/shoes" });
  });
});
