export type Action = "answer" | "inquiry" | "clarify";
export type Availability = "in_stock" | "out_of_stock" | "unknown";
export type ConfigName = "A" | "B" | "C";

export interface Fact {
  title?: string;
  price: number | null;
  currency: string | null;
  price_status: string;
  availability: Availability;
}

export interface Gold {
  id: string;
  store: string;
  lang: string;
  category: string;
  query: string;
  must_ids: string[];
  ok_ids: string[];
  forbidden_ids: string[];
  expected_action: Action;
  facts: Record<string, Fact>;
  text_any?: string[];
  notes?: string;
}

export interface AnswerOffer {
  offer_id: string;
  price: number | null;
  availability: Availability | null;
}

export interface Answer {
  action: Action;
  offers: AnswerOffer[];
  text: string;
}

export interface RunRecord {
  queryId: string;
  config: ConfigName;
  run: number;
  answer: Answer | null;
  toolCalls: string[];
  reports: string[];
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  internalInputTokens: number;
  internalOutputTokens: number;
  latencyMs: number;
  error?: string;
}

export type ErrorKind =
  | "unknown_offer"
  | "wrong_price"
  | "price_on_request"
  | "wrong_availability"
  | "wrong_price_text"
  | "not_found";

export interface RunScore {
  queryId: string;
  config: ConfigName;
  lang: string;
  category: string;
  accurate: boolean;
  topHit: boolean;
  noForbidden: boolean;
  factsOk: boolean;
  actionOk: boolean;
  textOk: boolean;
  confidentError: boolean;
  errors: ErrorKind[];
  recallAt5: number | null;
  expectedAction: Action;
  closed: boolean;
  handedOver: boolean;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  toolCalls: number;
  latencyMs: number;
  usedRaw: boolean;
  wrongReport: boolean;
}

export const RAW_TOOLS = [
  "search_offers",
  "get_offer_details",
  "check_availability",
  "compare_offers",
];

const HEDGE =
  /уточн|подтверд|по запросу|нужно спросить|свяжитесь|confirm with|to be confirmed|ask the store|check with the store|contact the store|on request|not confirmed|нақтыла|растау|сұраныс|дүкенге хабарлас/i;

const CURRENCY = /^\s*(тг|₸|kzt|tenge|тенге|теңге)/i;

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/(?<=\d)[\s ,.](?=\d{3}(?!\d))/g, "");
}

export function parseAction(value: unknown): Action | null {
  return value === "answer" || value === "inquiry" || value === "clarify" ? value : null;
}

function parsePrice(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const digits = Number(normalizeText(value).replace(/[^\d.]/g, ""));
    return value.trim() && Number.isFinite(digits) && /\d/.test(value) ? digits : null;
  }
  return null;
}

function parseAvailability(value: unknown): Availability | null {
  return value === "in_stock" || value === "out_of_stock" || value === "unknown" ? value : null;
}

/** Extracts the final JSON answer from a model reply; null when it carries none. */
export function parseAnswer(content: string | null): Answer | null {
  if (!content) return null;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const action = parseAction(record.action);
  if (!action) return null;
  const offers: AnswerOffer[] = [];
  if (Array.isArray(record.offers)) {
    for (const item of record.offers) {
      if (typeof item === "string") {
        offers.push({ offer_id: item, price: null, availability: null });
      } else if (typeof item === "object" && item !== null) {
        const row = item as Record<string, unknown>;
        if (typeof row.offer_id !== "string") continue;
        offers.push({
          offer_id: row.offer_id,
          price: parsePrice(row.price),
          availability: parseAvailability(row.availability),
        });
      }
    }
  }
  return { action, offers, text: typeof record.answer === "string" ? record.answer : "" };
}

/** Amounts in a reply that read as prices: 12 000, 75k, 5000 тг. Times and phone numbers are skipped. */
export function priceNumbers(text: string): number[] {
  const cleaned = normalizeText(text)
    .replace(/\+\d[\d\s()-]*/g, " ")
    .replace(/\d{1,2}:\d{2}/g, " ");
  const found: number[] = [];
  for (const match of cleaned.matchAll(
    /(\d+(?:\.\d+)?)(\s*(?:kzt|tenge|тенге|теңге|тыс|мың|тг|₸|k|к)(?![a-zа-яәіңғүұқөһ]))?/g,
  )) {
    const base = Number(match[1]);
    const suffix = (match[2] ?? "").trim();
    const scaled = /^(k|к|тыс|мың)$/.test(suffix) ? base * 1000 : base;
    const currency = CURRENCY.test(match[2] ?? "");
    if (scaled >= 1000 || currency) found.push(scaled);
  }
  return found;
}

export function plausiblePrices(facts: Iterable<Fact>): Set<number> {
  const prices = [...facts].flatMap((f) => (f.price === null ? [] : [f.price]));
  const allowed = new Set<number>(prices);
  for (const a of prices) for (const b of prices) allowed.add(a + b);
  return allowed;
}

function queryNumbers(query: string): number[] {
  return priceNumbers(query);
}

export interface ScoreContext {
  gold: Gold;
  catalog?: Record<string, Fact>;
}

function factOf(id: string, { gold, catalog }: ScoreContext): Fact | undefined {
  return gold.facts[id] ?? catalog?.[id];
}

export function findErrors(answer: Answer, context: ScoreContext): ErrorKind[] {
  const { gold, catalog } = context;
  const errors = new Set<ErrorKind>();
  for (const offer of answer.offers) {
    const fact = factOf(offer.offer_id, context);
    if (!fact) {
      errors.add("unknown_offer");
      continue;
    }
    if (offer.price !== null) {
      if (fact.price_status !== "confirmed" || fact.price === null) errors.add("price_on_request");
      else if (offer.price !== fact.price) errors.add("wrong_price");
    }
    if (
      (offer.availability === "in_stock" || offer.availability === "out_of_stock") &&
      offer.availability !== fact.availability
    ) {
      errors.add("wrong_availability");
    }
  }
  const allowed = plausiblePrices(Object.values({ ...catalog, ...gold.facts }));
  for (const n of queryNumbers(gold.query)) allowed.add(n);
  if (priceNumbers(answer.text).some((n) => !allowed.has(n))) errors.add("wrong_price_text");
  if (answer.action === "answer" && answer.offers.length === 0 && gold.must_ids.length > 0) {
    errors.add("not_found");
  }
  return [...errors];
}

export function textMatches(gold: Gold, text: string): boolean {
  if (!gold.text_any || gold.text_any.length === 0) return true;
  const haystack = normalizeText(text);
  return gold.text_any.some((needle) => haystack.includes(normalizeText(needle)));
}

export function recallAt5(gold: Gold, ids: string[]): number | null {
  const relevant = new Set([...gold.must_ids, ...gold.ok_ids]);
  if (relevant.size === 0) return null;
  const top = new Set(ids.slice(0, 5));
  let hit = 0;
  for (const id of relevant) if (top.has(id)) hit++;
  return hit / Math.min(relevant.size, 5);
}

export function usedRawAfterFind(toolCalls: string[]): boolean {
  const first = toolCalls.indexOf("find_offers");
  if (first < 0) return false;
  return toolCalls.slice(first + 1).some((name) => RAW_TOOLS.includes(name));
}

export function scoreRun(record: RunRecord, context: ScoreContext): RunScore {
  const { gold } = context;
  const answer = record.answer;
  const ids = answer?.offers.map((o) => o.offer_id) ?? [];
  const errors = answer ? findErrors(answer, context) : [];
  const forbidden = new Set(gold.forbidden_ids);
  const topHit =
    gold.must_ids.length === 0 || ids.slice(0, 3).some((id) => gold.must_ids.includes(id));
  const noForbidden = !ids.some((id) => forbidden.has(id));
  const factsOk = errors.every((e) => e === "not_found");
  const actionOk = answer?.action === gold.expected_action;
  const textOk = answer ? textMatches(gold, answer.text) : false;
  const accurate = !!answer && topHit && noForbidden && factsOk && actionOk && textOk;
  const confidentError = errors.length > 0;
  const closed =
    gold.expected_action === "answer" &&
    accurate &&
    answer?.action === "answer" &&
    !HEDGE.test(answer.text);
  const handedOver =
    gold.expected_action === "inquiry" && answer?.action === "inquiry" && noForbidden && factsOk;
  return {
    queryId: gold.id,
    config: record.config,
    lang: gold.lang,
    category: gold.category,
    accurate,
    topHit,
    noForbidden,
    factsOk,
    actionOk,
    textOk,
    confidentError,
    errors,
    recallAt5: answer ? recallAt5(gold, ids) : recallAt5(gold, []),
    expectedAction: gold.expected_action,
    closed,
    handedOver,
    tokens:
      record.promptTokens +
      record.completionTokens +
      record.internalInputTokens +
      record.internalOutputTokens,
    inputTokens: record.promptTokens + record.internalInputTokens,
    outputTokens: record.completionTokens + record.internalOutputTokens,
    cachedTokens: record.cachedTokens,
    toolCalls: record.toolCalls.length,
    latencyMs: record.latencyMs,
    usedRaw: usedRawAfterFind(record.toolCalls),
    wrongReport: record.reports.includes("wrong"),
  };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? 0;
}

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

const rate = (hits: number, total: number): number | null => (total === 0 ? null : hits / total);

export interface Aggregate {
  runs: number;
  accuracy: number | null;
  recallAt5: number | null;
  confidentErrors: number | null;
  closedWithoutHuman: number | null;
  handedOver: number | null;
  tokensMean: number;
  inputMean: number;
  outputMean: number;
  tokensP50: number;
  tokensP95: number;
  cachedMean: number;
  toolCallsMean: number;
  latencyP50: number;
  latencyP95: number;
  rawFallback: number | null;
  wrongReport: number | null;
}

export function aggregate(scores: RunScore[], config?: ConfigName): Aggregate {
  const answerRuns = scores.filter((s) => s.expectedAction === "answer");
  const inquiryRuns = scores.filter((s) => s.expectedAction === "inquiry");
  const recalls = scores.flatMap((s) => (s.recallAt5 === null ? [] : [s.recallAt5]));
  const isC = (config ?? scores[0]?.config) === "C";
  return {
    runs: scores.length,
    accuracy: rate(scores.filter((s) => s.accurate).length, scores.length),
    recallAt5: recalls.length === 0 ? null : mean(recalls),
    confidentErrors: rate(scores.filter((s) => s.confidentError).length, scores.length),
    closedWithoutHuman: rate(answerRuns.filter((s) => s.closed).length, answerRuns.length),
    handedOver: rate(inquiryRuns.filter((s) => s.handedOver).length, inquiryRuns.length),
    tokensMean: mean(scores.map((s) => s.tokens)),
    inputMean: mean(scores.map((s) => s.inputTokens)),
    outputMean: mean(scores.map((s) => s.outputTokens)),
    tokensP50: percentile(
      scores.map((s) => s.tokens),
      50,
    ),
    tokensP95: percentile(
      scores.map((s) => s.tokens),
      95,
    ),
    cachedMean: mean(scores.map((s) => s.cachedTokens)),
    toolCallsMean: mean(scores.map((s) => s.toolCalls)),
    latencyP50: percentile(
      scores.map((s) => s.latencyMs),
      50,
    ),
    latencyP95: percentile(
      scores.map((s) => s.latencyMs),
      95,
    ),
    rawFallback: isC ? rate(scores.filter((s) => s.usedRaw).length, scores.length) : null,
    wrongReport: isC ? rate(scores.filter((s) => s.wrongReport).length, scores.length) : null,
  };
}

export function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = groups.get(k);
    if (list) list.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

export interface RawFallbackAccuracy {
  queries: number;
  accuracy: Partial<Record<ConfigName, number | null>>;
}

/** Accuracy of every config on the queries where C went to the raw tools after find_offers. */
export function rawFallbackAccuracy(scores: RunScore[]): RawFallbackAccuracy {
  const queries = new Set(
    scores.filter((s) => s.config === "C" && s.usedRaw).map((s) => s.queryId),
  );
  const accuracy: RawFallbackAccuracy["accuracy"] = {};
  for (const config of ["A", "B", "C"] as const) {
    const subset = scores.filter((s) => s.config === config && queries.has(s.queryId));
    accuracy[config] = rate(subset.filter((s) => s.accurate).length, subset.length);
  }
  return { queries: queries.size, accuracy };
}

export function costPer1000(
  tokensInOut: { input: number; output: number },
  price: { inputPerMillion: number; outputPerMillion: number } | null,
): number | null {
  if (!price) return null;
  return (
    ((tokensInOut.input * price.inputPerMillion + tokensInOut.output * price.outputPerMillion) /
      1_000_000) *
    1000
  );
}
