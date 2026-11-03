import { describe, expect, it } from "vitest";
import {
  agentAnswers,
  agentOutcome,
  channelCounts,
  dailySeries,
  orderValue,
  parseRange,
  topQueries,
} from "@/server/owner/analytics";
import type { ConversationStats } from "@/server/services/conversations";

function stats(overrides: Partial<ConversationStats> = {}): ConversationStats {
  return {
    total: 4,
    byChannel: { storefront: 3, external_agent: 1, workspace: 0 },
    withOrder: 1,
    withInquiry: 1,
    withOutcome: 2,
    ...overrides,
  };
}

describe("analytics", () => {
  it("parses the range with a 30 day default", () => {
    expect(parseRange("7")).toBe(7);
    expect(parseRange("30")).toBe(30);
    expect(parseRange("90")).toBe(30);
    expect(parseRange(undefined)).toBe(30);
  });

  it("lists customer channels in a fixed order", () => {
    expect(channelCounts(stats().byChannel).map((c) => [c.channel, c.count])).toEqual([
      ["storefront", 3],
      ["external_agent", 1],
    ]);
  });

  it("formats order value per currency", () => {
    expect(orderValue([{ currency: "KZT", total: 500 }])).toEqual(["500 ₸"]);
    expect(orderValue([])).toEqual([]);
  });

  it("measures conversations that ended in an order or a question", () => {
    expect(agentOutcome(stats(), { total: 3, new: 1 })).toMatchObject({
      conversations: 4,
      toOrder: 1,
      toInquiry: 1,
      unresolved: 1,
      resolvedShare: 0.5,
    });
  });

  it("has no share without conversations", () => {
    const empty = stats({ total: 0, withOrder: 0, withInquiry: 0, withOutcome: 0 });
    expect(agentOutcome(empty, { total: 0, new: 0 }).resolvedShare).toBeNull();
  });

  it("groups first messages case-insensitively and trims long ones", () => {
    const queries = topQueries([
      "Winter boots?",
      "winter boots",
      " ",
      "Kids shoes",
      "x".repeat(200),
    ]);
    expect(queries[0]).toEqual({ text: "Winter boots?", count: 2 });
    expect(queries).toHaveLength(3);
    expect(queries.every((q) => q.text.length <= 80)).toBe(true);
  });

  it("drops tool calls and JSON", () => {
    const queries = topQueries([
      "search_offers: school sneakers",
      'get_offer_details({"id":"1"})',
      '{"query":"boots"}',
      "Do you deliver?",
    ]);
    expect(queries).toEqual([{ text: "Do you deliver?", count: 1 }]);
  });

  it("fills every day of the range and keeps zero days", () => {
    const now = new Date("2026-11-03T10:00:00Z");
    const series = dailySeries(
      now,
      3,
      {
        conversations: [{ day: "2026-11-03", count: 2 }],
        orders: [{ day: "2026-11-01", count: 1 }],
        inquiries: [],
      },
      "UTC",
    );
    expect(series).toEqual([
      { day: "2026-11-01", conversations: 0, orders: 1, inquiries: 0 },
      { day: "2026-11-02", conversations: 0, orders: 0, inquiries: 0 },
      { day: "2026-11-03", conversations: 2, orders: 0, inquiries: 0 },
    ]);
  });
});

describe("agent answers", () => {
  it("shares wrong and incomplete verdicts among rated answers", () => {
    expect(
      agentAnswers({ findOffers: 10, reported: 4, wrong: 1, incomplete: 1, followedByRaw: 3 }),
    ).toEqual({ findOffers: 10, rated: 4, flaggedShare: 0.5, rawShare: 0.3 });
  });

  it("has no shares before anything happened", () => {
    expect(
      agentAnswers({ findOffers: 0, reported: 0, wrong: 0, incomplete: 0, followedByRaw: 0 }),
    ).toEqual({ findOffers: 0, rated: 0, flaggedShare: null, rawShare: null });
  });

  it("never reports a raw share above 100 percent", () => {
    expect(
      agentAnswers({ findOffers: 2, reported: 0, wrong: 0, incomplete: 0, followedByRaw: 5 })
        .rawShare,
    ).toBe(1);
  });
});
