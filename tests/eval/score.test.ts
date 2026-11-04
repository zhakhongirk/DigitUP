import { describe, expect, it } from "vitest";
import {
  aggregate,
  findErrors,
  parseAnswer,
  percentile,
  priceNumbers,
  rawFallbackAccuracy,
  recallAt5,
  scoreRun,
  usedRawAfterFind,
  type Answer,
  type Fact,
  type Gold,
  type RunRecord,
} from "@/scripts/eval/score";
import { buildTables, toHtml, toMarkdown } from "@/scripts/eval/report";

const fact = (price: number | null, availability: Fact["availability"]): Fact => ({
  price,
  currency: price === null ? null : "KZT",
  price_status: price === null ? "on_request" : "confirmed",
  availability,
});

const gold: Gold = {
  id: "q1",
  store: "shop",
  lang: "ru",
  category: "budget",
  query: "кроссовки до 75к",
  must_ids: ["a"],
  ok_ids: ["b"],
  forbidden_ids: ["x"],
  expected_action: "answer",
  facts: {
    a: fact(42000, "in_stock"),
    b: fact(null, "unknown"),
    x: fact(90000, "out_of_stock"),
  },
};

function answer(overrides: Partial<Answer> = {}): Answer {
  return {
    action: "answer",
    offers: [{ offer_id: "a", price: 42000, availability: "in_stock" }],
    text: "Nordix за 42 000 тг",
    ...overrides,
  };
}

function record(a: Answer | null, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    queryId: "q1",
    config: "B",
    run: 1,
    answer: a,
    toolCalls: ["find_offers"],
    reports: [],
    promptTokens: 100,
    completionTokens: 20,
    cachedTokens: 10,
    internalInputTokens: 30,
    internalOutputTokens: 5,
    latencyMs: 800,
    ...overrides,
  };
}

describe("parseAnswer", () => {
  it("reads the JSON object inside a fenced reply", () => {
    const parsed = parseAnswer(
      'Here you go\n```json\n{"action":"answer","offers":[{"offer_id":"a","price":"42 000","availability":"in_stock"},"b"],"answer":"ok"}\n```',
    );
    expect(parsed).toEqual({
      action: "answer",
      offers: [
        { offer_id: "a", price: 42000, availability: "in_stock" },
        { offer_id: "b", price: null, availability: null },
      ],
      text: "ok",
    });
  });

  it("returns null for replies without a valid action", () => {
    expect(parseAnswer("no json")).toBeNull();
    expect(parseAnswer('{"action":"buy"}')).toBeNull();
    expect(parseAnswer(null)).toBeNull();
  });
});

describe("priceNumbers", () => {
  it("finds amounts with thousand separators, k suffixes and currency", () => {
    expect(priceNumbers("42 000 тг и 75к, 5000 KZT")).toEqual([42000, 75000, 5000]);
  });

  it("ignores sizes, times and phone numbers", () => {
    expect(priceNumbers("размер 43, открыто 10:00-21:00, +7 727 244 88 10")).toEqual([]);
  });
});

describe("findErrors", () => {
  it("accepts correct prices and availability", () => {
    expect(findErrors(answer(), { gold })).toEqual([]);
  });

  it("flags a wrong price, a price for an on-request offer and a wrong availability", () => {
    const wrong = answer({
      offers: [
        { offer_id: "a", price: 41000, availability: "out_of_stock" },
        { offer_id: "b", price: 50000, availability: "in_stock" },
      ],
    });
    expect(findErrors(wrong, { gold }).sort()).toEqual(
      ["price_on_request", "wrong_availability", "wrong_price"].sort(),
    );
  });

  it("flags offer ids that are not in the catalog", () => {
    const fabricated = answer({ offers: [{ offer_id: "zzz", price: null, availability: null }] });
    expect(findErrors(fabricated, { gold })).toContain("unknown_offer");
    expect(findErrors(fabricated, { gold, catalog: { zzz: fact(1000, "in_stock") } })).toEqual([]);
  });

  it("flags a price in the text that no offer has, but allows the budget and sums", () => {
    expect(findErrors(answer({ text: "стоит 39 990 тг" }), { gold })).toContain("wrong_price_text");
    expect(findErrors(answer({ text: "до 75к: 42 000 тг" }), { gold })).toEqual([]);
  });

  it("flags 'nothing found' when a must offer exists", () => {
    expect(findErrors(answer({ offers: [], text: "ничего нет" }), { gold })).toEqual(["not_found"]);
  });
});

describe("recallAt5", () => {
  it("counts must and ok ids found in the first five", () => {
    expect(recallAt5(gold, ["a", "q", "b"])).toBe(1);
    expect(recallAt5(gold, ["q", "w", "e", "r", "t", "a"])).toBe(0);
    expect(recallAt5(gold, ["a"])).toBe(0.5);
  });

  it("is null when nothing is relevant", () => {
    expect(recallAt5({ ...gold, must_ids: [], ok_ids: [] }, ["a"])).toBeNull();
  });
});

describe("scoreRun", () => {
  it("scores a correct answer as accurate and closed without a human", () => {
    const score = scoreRun(record(answer()), { gold });
    expect(score).toMatchObject({
      accurate: true,
      closed: true,
      confidentError: false,
      tokens: 155,
      inputTokens: 130,
      outputTokens: 25,
      usedRaw: false,
    });
  });

  it("requires a must id in the top three", () => {
    const offers = [
      { offer_id: "b", price: null, availability: null },
      { offer_id: "b", price: null, availability: null },
      { offer_id: "b", price: null, availability: null },
      { offer_id: "a", price: 42000, availability: null },
    ];
    expect(scoreRun(record(answer({ offers })), { gold }).topHit).toBe(false);
  });

  it("rejects forbidden offers and a wrong action", () => {
    const forbidden = answer({
      offers: [
        { offer_id: "a", price: null, availability: null },
        { offer_id: "x", price: null, availability: null },
      ],
    });
    expect(scoreRun(record(forbidden), { gold }).accurate).toBe(false);
    expect(scoreRun(record(answer({ action: "inquiry" })), { gold }).actionOk).toBe(false);
  });

  it("does not count a hedged reply as closed without a human", () => {
    const hedged = answer({ text: "42 000 тг, наличие уточните у магазина" });
    const score = scoreRun(record(hedged), { gold });
    expect(score.accurate).toBe(true);
    expect(score.closed).toBe(false);
  });

  it("scores a missing answer as inaccurate without a confident error", () => {
    const score = scoreRun(record(null, { error: "step_limit" }), { gold });
    expect(score.accurate).toBe(false);
    expect(score.confidentError).toBe(false);
  });

  it("marks a correct hand-over for inquiry queries", () => {
    const inquiry: Gold = { ...gold, must_ids: ["b"], expected_action: "inquiry" };
    const a = answer({
      action: "inquiry",
      offers: [{ offer_id: "b", price: null, availability: "unknown" }],
      text: "Цена по запросу",
    });
    const score = scoreRun(record(a), { gold: inquiry });
    expect(score).toMatchObject({ handedOver: true, accurate: true, closed: false });
  });

  it("checks required phrases in the text", () => {
    const policy: Gold = { ...gold, must_ids: [], ok_ids: [], text_any: ["3-5"] };
    const a = answer({ offers: [], text: "Доставка 3-5 дней" });
    expect(scoreRun(record(a), { gold: policy }).accurate).toBe(true);
    expect(scoreRun(record({ ...a, text: "Доставка быстро" }), { gold: policy }).accurate).toBe(
      false,
    );
  });
});

describe("raw fallback", () => {
  it("detects raw tools called after find_offers only", () => {
    expect(usedRawAfterFind(["find_offers", "check_availability"])).toBe(true);
    expect(usedRawAfterFind(["search_offers", "find_offers"])).toBe(false);
    expect(usedRawAfterFind(["find_offers", "get_business_info", "report_answer"])).toBe(false);
  });

  it("compares accuracy of the configs on the fallback queries", () => {
    const good = answer();
    const bad = answer({ action: "inquiry" });
    const scores = [
      scoreRun(record(good, { config: "A" }), { gold }),
      scoreRun(record(bad, { config: "B" }), { gold }),
      scoreRun(record(good, { config: "C", toolCalls: ["find_offers", "search_offers"] }), {
        gold,
      }),
    ];
    expect(rawFallbackAccuracy(scores)).toEqual({
      queries: 1,
      accuracy: { A: 1, B: 0, C: 1 },
    });
  });
});

describe("aggregate and report", () => {
  const scores = [
    scoreRun(record(answer(), { latencyMs: 100 }), { gold }),
    scoreRun(record(answer({ action: "inquiry" }), { latencyMs: 300 }), { gold }),
    scoreRun(
      record(answer({ offers: [{ offer_id: "a", price: 1, availability: null }] }), {
        latencyMs: 200,
      }),
      { gold },
    ),
    scoreRun(record(answer({ offers: [] }), { latencyMs: 400 }), { gold }),
  ];

  it("computes rates and percentiles", () => {
    const a = aggregate(scores, "B");
    expect(a.runs).toBe(4);
    expect(a.accuracy).toBe(0.25);
    expect(a.confidentErrors).toBe(0.5);
    expect(a.closedWithoutHuman).toBe(0.25);
    expect(a.latencyP50).toBe(200);
    expect(a.latencyP95).toBe(400);
    expect(a.rawFallback).toBeNull();
  });

  it("computes nearest-rank percentiles", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([], 95)).toBe(0);
  });

  it("renders tables by config, language and category", () => {
    const tables = buildTables(scores);
    expect(tables.map((t) => t.title)).toEqual(["Overall", "By language", "By category"]);
    expect(toMarkdown(tables, "Eval")).toContain("| B find_offers | 4 | 25.0% |");
    expect(toHtml(tables, "Eval")).toContain("<td>ru</td>");
  });
});

describe("size variants", () => {
  const sized = (price: number, availability: Fact["availability"], model = "M"): Fact => ({
    ...fact(price, availability),
    model,
  });
  const variantGold: Gold = {
    ...gold,
    must_ids: ["m41", "m42"],
    ok_ids: [],
    forbidden_ids: ["f41", "f42"],
    facts: {
      m41: sized(40000, "out_of_stock"),
      m42: sized(42000, "in_stock"),
      f41: sized(90000, "in_stock", "F"),
      f42: sized(90000, "in_stock", "F"),
    },
  };
  const ctx = { gold: variantGold };

  it("counts any size of an expected model as a hit and any size of a forbidden one as a miss", () => {
    const hit = scoreRun(
      record(answer({ offers: [{ offer_id: "m42", price: 42000, availability: "in_stock" }] })),
      ctx,
    );
    expect(hit.topHit).toBe(true);
    const bad = scoreRun(
      record(answer({ offers: [{ offer_id: "f41", price: 90000, availability: null }] })),
      ctx,
    );
    expect(bad.noForbidden).toBe(false);
    expect(bad.topHit).toBe(false);
  });

  it("accepts the price or availability of a sibling size of the same model", () => {
    const lead = { offer_id: "m41", price: 42000, availability: "in_stock" as const };
    expect(findErrors(answer({ offers: [lead], text: "" }), ctx)).toEqual([]);
    const wrong = { offer_id: "m41", price: 41000, availability: null };
    expect(findErrors(answer({ offers: [wrong], text: "" }), ctx)).toContain("wrong_price");
  });

  it("measures recall by model, not by size", () => {
    expect(recallAt5(variantGold, ["m41", "m42"])).toBe(1);
    expect(recallAt5(variantGold, ["f41"])).toBe(0);
  });
});
