import type { TextLang } from "@/shared/text-lang";
import type { Execution, RelaxStep } from "./resolve";

interface Words {
  found: (n: number) => string;
  nothing: string;
  forWhat: (what: string) => string;
  relaxed: string;
  steps: Record<RelaxStep["step"], string>;
  budgetUpTo: string;
  onRequest: (n: number) => string;
  unresolved: string;
}

const WORDS: Record<TextLang, Words> = {
  en: {
    found: (n) => `Found ${n} ${n === 1 ? "offer" : "offers"}`,
    nothing: "Nothing found",
    forWhat: (what) => ` for ${what}`,
    relaxed: "There was no exact match, so these filters were loosened: ",
    steps: { size: "size", color: "color", budget: "budget", category: "category" },
    budgetUpTo: "up to",
    onRequest: (n) =>
      `${n} more ${n === 1 ? "has its" : "have their"} price on request, listed separately.`,
    unresolved: "Not understood: ",
  },
  ru: {
    found: (n) => `Найдено позиций: ${n}`,
    nothing: "Ничего не найдено",
    forWhat: (what) => ` по запросу: ${what}`,
    relaxed: "Точного совпадения не было, поэтому ослаблены фильтры: ",
    steps: { size: "размер", color: "цвет", budget: "бюджет", category: "категория" },
    budgetUpTo: "до",
    onRequest: (n) => `Ещё позиций с ценой по запросу: ${n}, они показаны отдельно.`,
    unresolved: "Не удалось понять: ",
  },
  kk: {
    found: (n) => `Табылған ұсыныстар: ${n}`,
    nothing: "Ештеңе табылмады",
    forWhat: (what) => ` сұраныс бойынша: ${what}`,
    relaxed: "Нақты сәйкестік болмады, сондықтан сүзгілер жеңілдетілді: ",
    steps: { size: "өлшем", color: "түс", budget: "бюджет", category: "санат" },
    budgetUpTo: "дейін",
    onRequest: (n) => `Бағасы сұраныс бойынша тағы ${n} ұсыныс бөлек көрсетілді.`,
    unresolved: "Түсінілмеді: ",
  },
};

function amount(value: number, currency: string | null): string {
  const text = new Intl.NumberFormat("en-US").format(value).replace(/,/g, " ");
  return currency ? `${text} ${currency}` : text;
}

export function summarize(execution: Execution): string {
  const w = WORDS[execution.lang];
  const { applied, relaxed, unresolved } = execution;
  const currency =
    [...execution.offers, ...execution.onRequest].find((m) => m.offer.currency)?.offer.currency ??
    null;

  const what: string[] = [];
  for (const [, value] of Object.entries(applied.attributes)) {
    if (typeof value === "string" && value !== applied.size?.values[0]) what.push(value);
  }
  if (applied.category) what.push(applied.category);
  what.push(...applied.terms);
  if (applied.size) what.push(applied.size.requested);
  if (applied.max_price !== null)
    what.push(`${w.budgetUpTo} ${amount(applied.max_price, currency)}`);

  const subject = what.length > 0 ? w.forWhat(what.join(", ")) : "";
  const total = execution.total + execution.onRequestTotal;
  const parts = [
    total === 0 ? `${w.nothing}${subject}.` : `${w.found(execution.total)}${subject}.`,
  ];
  if (relaxed.length > 0) {
    parts.push(`${w.relaxed}${relaxed.map((r) => w.steps[r.step]).join(", ")}.`);
  }
  if (execution.onRequestTotal > 0) parts.push(w.onRequest(execution.onRequestTotal));
  const open = unresolved.filter((u) => u !== "no matching offers");
  if (open.length > 0) parts.push(`${w.unresolved}${open.join("; ")}.`);
  return parts.join(" ");
}
