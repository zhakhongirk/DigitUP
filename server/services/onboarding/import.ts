/**
 * Builds a Business Model draft from uploaded sources without a language
 * model: the largest product table becomes the catalog, contacts and policy
 * sentences are picked from the text. Everything it cannot read stays an
 * explicit gap (price on request, unknown stock, open questions).
 */
import type {
  AttributeDefinition,
  AttributeValue,
  BusinessModelInput,
  Contacts,
  MissingInfoItem,
  OfferKind,
} from "@/shared/business-model";
import type { ExtractedTable } from "../ingestion/extract";

export interface ImportSources {
  businessName: string;
  /** Plain text of every source: the owner's description and extracted files. */
  texts: string[];
  tables: ExtractedTable[];
}

type Role = "title" | "price" | "currency" | "category" | "description" | "availability" | "image";

const ROLE_PATTERNS: [Role, RegExp][] = [
  [
    "title",
    /^(name|title|product|item|service|model|наименование|название|товар|услуга|модель)(?![\p{L}\d_])/iu,
  ],
  ["price", /(price|cost|amount|цена|стоимость|прайс)/i],
  ["currency", /^(currency|валюта)$/i],
  ["category", /^(category|categories|section|group|категория|раздел|группа)(?![\p{L}\d_])/iu],
  ["description", /^(description|details|notes?|описание)(?![\p{L}\d_])/iu],
  ["availability", /(stock|availability|available|qty|quantity|наличие|остаток|количество)/i],
  ["image", /^(image|photo|picture|image_url|фото)(?![\p{L}\d_])/iu],
];

const CURRENCY_HINTS: [RegExp, string][] = [
  [/₸|\bkzt\b|тенге|tenge|теңге/i, "KZT"],
  [/\$|\busd\b|dollars?/i, "USD"],
  [/€|\beur\b|euros?/i, "EUR"],
  [/₽|\brub\b|руб/i, "RUB"],
  [/£|\bgbp\b/i, "GBP"],
];

const SERVICE_HINT = /(duration|minutes|min\b|длительность|минут|время)/i;

const POLICY_PATTERNS: [keyof PoliciesDraft, RegExp][] = [
  ["delivery", /(deliver|shipping|courier|pickup|pick-up|доставк|курьер|самовывоз)/i],
  ["payment", /(payment|pay\b|cash|card|kaspi|оплат|наличн|карт)/i],
  ["returns", /(return|refund|exchange|возврат|обмен)/i],
  [
    "working_hours",
    /(open\b|opening hours|working hours|hours:|daily|every day|график|часы работы|ежедневно|\b\d{1,2}[:.]\d{2}\s*[-–]\s*\d{1,2}[:.]\d{2})/i,
  ],
];

interface PoliciesDraft {
  delivery: string | null;
  payment: string | null;
  returns: string | null;
  working_hours: string | null;
  other: string | null;
}

const POLICY_QUESTIONS: Record<keyof PoliciesDraft, string | null> = {
  delivery: "Do you deliver, and on what terms?",
  payment: "Which payment methods do you accept?",
  returns: "What is your return or cancellation policy?",
  working_hours: "What are your working hours?",
  other: null,
};

const clean = (value: string | undefined) => (value ?? "").replace(/\s+/g, " ").trim();

function detectCurrency(text: string): string | null {
  for (const [pattern, code] of CURRENCY_HINTS) if (pattern.test(text)) return code;
  return null;
}

/** Parses "42 000 ₸", "1,250.50", "1 250,5" into a number; null when it is not a price. */
export function parsePrice(raw: string): number | null {
  let text = raw.replace(/[^\d.,]/g, "");
  if (text === "" || !/\d/.test(text)) return null;
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    const decimal = lastComma > lastDot ? "," : ".";
    text = text.replace(decimal === "," ? /\./g : /,/g, "").replace(",", ".");
  } else if (lastComma > -1) {
    text = /,\d{1,2}$/.test(text) ? text.replace(",", ".") : text.replace(/,/g, "");
  } else if ((text.match(/\./g) ?? []).length > 1) {
    text = text.replace(/\./g, "");
  }
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : null;
}

function parseAvailability(raw: string): "in_stock" | "out_of_stock" | "unknown" {
  const text = clean(raw).toLowerCase();
  if (text === "") return "unknown";
  const qty = Number(text.replace(/\s/g, ""));
  if (Number.isFinite(qty)) return qty > 0 ? "in_stock" : "out_of_stock";
  if (/(out of stock|sold out|unavailable|no\b|нет|закончил)/.test(text)) return "out_of_stock";
  if (/(in stock|available|yes|есть|в наличии)/.test(text)) return "in_stock";
  return "unknown";
}

function toKey(label: string, used: Set<string>, index: number): string {
  let key = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "a_$1")
    .slice(0, 48);
  if (!/^[a-z]/.test(key)) key = `attribute_${index + 1}`;
  let unique = key;
  for (let n = 2; used.has(unique); n++) unique = `${key}_${n}`;
  used.add(unique);
  return unique;
}

function roleOf(header: string): Role | null {
  for (const [role, pattern] of ROLE_PATTERNS) if (pattern.test(header)) return role;
  return null;
}

interface Catalog {
  table: ExtractedTable;
  header: string[];
  rows: string[][];
  roles: Map<number, Role>;
}

function findCatalog(tables: ExtractedTable[]): Catalog | null {
  let best: Catalog | null = null;
  for (const table of tables) {
    const headerIndex = table.rows.findIndex((row) =>
      row.some((cell) => roleOf(clean(cell)) === "title"),
    );
    if (headerIndex < 0 || headerIndex > 5) continue;
    const header = table.rows[headerIndex]!.map(clean);
    const roles = new Map<number, Role>();
    const taken = new Set<Role>();
    header.forEach((cell, i) => {
      const role = roleOf(cell);
      if (role && !taken.has(role)) {
        roles.set(i, role);
        taken.add(role);
      }
    });
    const titleCol = [...roles].find(([, role]) => role === "title")![0];
    const rows = table.rows.slice(headerIndex + 1).filter((row) => clean(row[titleCol]) !== "");
    if (rows.length > 0 && (!best || rows.length > best.rows.length)) {
      best = { table, header, rows, roles };
    }
  }
  return best;
}

/** "Duration, min" and "Weight (kg)" become a label and a unit. */
function splitUnit(header: string): { label: string; unit: string | null } {
  const match = header.match(/^(.+?)\s*(?:,\s*([^,()]{1,6})|\(([^()]{1,6})\))$/);
  if (!match) return { label: header, unit: null };
  return { label: match[1]!.trim(), unit: (match[2] ?? match[3])!.trim() };
}

function attributeDefinitions(catalog: Catalog): { def: AttributeDefinition; col: number }[] {
  const used = new Set<string>();
  const defs: { def: AttributeDefinition; col: number }[] = [];
  catalog.header.forEach((header, col) => {
    if (catalog.roles.has(col) || header === "") return;
    const values = catalog.rows.map((row) => clean(row[col])).filter((v) => v !== "");
    if (values.length === 0) return;
    const { label, unit } = splitUnit(header);
    const key = toKey(label, used, col);
    const numeric = values.every((v) => /^-?\d+([.,]\d+)?$/.test(v));
    const distinct = [...new Set(values)];
    let def: AttributeDefinition;
    if (numeric) {
      def = { key, label, type: "number", required: false, ...(unit ? { unit } : {}) };
    } else if (
      distinct.length <= 8 &&
      distinct.length < values.length &&
      values.every((v) => v.length <= 40)
    ) {
      def = { key, label, type: "enum", options: distinct, required: false };
    } else {
      def = { key, label, type: "text", required: false };
    }
    defs.push({ def, col });
  });
  return defs;
}

function attributeValue(def: AttributeDefinition, raw: string): AttributeValue | null {
  const value = clean(raw);
  if (value === "") return null;
  if (def.type === "number") return Number(value.replace(",", "."));
  return value;
}

function findContacts(text: string): Contacts {
  const contacts: Contacts = {};
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.-]*\w/);
  if (email) contacts.email = email[0].toLowerCase();
  const phone = text.match(/(?:\+|\b)\d[\d\s()-]{8,}\d/);
  if (phone) contacts.phone = clean(phone[0]);
  const instagram = text.match(/(?:instagram(?:\.com\/|:\s*)|(?<![\w.])@)([a-z0-9._]{2,30})/i);
  if (instagram && !contacts.email?.includes(instagram[1]!.toLowerCase())) {
    contacts.instagram = `@${instagram[1]}`;
  }
  const whatsapp = text.match(/whats\s?app[:\s]+(\+?\d[\d\s()-]{8,}\d)/i);
  if (whatsapp) contacts.whatsapp = clean(whatsapp[1]);
  const telegram = text.match(/(?:t\.me\/|telegram[:\s]+@?)([a-z0-9_]{4,32})/i);
  if (telegram) contacts.telegram = `@${telegram[1]}`;
  const website = text.match(/\bhttps?:\/\/[^\s)]+/i);
  if (website) contacts.website = website[0];
  return contacts;
}

function sentences(text: string): string[] {
  return text
    .split(/\n+/)
    .filter((line) => !line.includes(" | ") && !/^Sheet: /.test(line))
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map(clean)
    .filter((s) => s.length >= 8 && s.length <= 300);
}

function findPolicies(texts: string[]): PoliciesDraft {
  const policies: PoliciesDraft = {
    delivery: null,
    payment: null,
    returns: null,
    working_hours: null,
    other: null,
  };
  const all = texts.flatMap(sentences);
  for (const [field, pattern] of POLICY_PATTERNS) {
    const hits = all.filter((s) => pattern.test(s)).slice(0, 2);
    if (hits.length > 0) policies[field] = hits.join(" ");
  }
  return policies;
}

const CONTACT_HINT = /(@|\+?\d[\d\s()-]{8,}\d|https?:\/\/|phone|email|whats\s?app|telegram)/i;

/** The first two plain sentences that are not contacts or policy terms. */
function describe(texts: string[]): string {
  const picked = texts
    .flatMap(sentences)
    .filter(
      (s) =>
        /[.!?]$/.test(s) &&
        !CONTACT_HINT.test(s) &&
        !POLICY_PATTERNS.some(([, pattern]) => pattern.test(s)),
    )
    .slice(0, 2)
    .join(" ");
  return picked.length > 500 ? `${picked.slice(0, 497).replace(/\s+\S*$/, "")}...` : picked;
}

export function importBusinessModel(sources: ImportSources): BusinessModelInput {
  const allText = sources.texts.join("\n");
  const catalog = findCatalog(sources.tables);
  const missing: MissingInfoItem[] = [];
  const contacts = findContacts(allText);
  const policies = findPolicies(sources.texts);

  let offerTypes: NonNullable<BusinessModelInput["offer_types"]> = [];
  let offers: NonNullable<BusinessModelInput["offers"]> = [];

  if (catalog) {
    const col = (role: Role) => [...catalog.roles].find(([, r]) => r === role)?.[0];
    const titleCol = col("title")!;
    const priceCol = col("price");
    const currencyCol = col("currency");
    const categoryCol = col("category");
    const descriptionCol = col("description");
    const availabilityCol = col("availability");
    const imageCol = col("image");
    const attrs = attributeDefinitions(catalog);
    const headerText = catalog.header.join(" ");
    const kind: OfferKind = SERVICE_HINT.test(headerText) ? "service" : "product";
    const defaultCurrency =
      detectCurrency(priceCol === undefined ? "" : catalog.header[priceCol]!) ??
      detectCurrency(
        priceCol === undefined ? "" : catalog.rows.map((r) => r[priceCol] ?? "").join(" "),
      ) ??
      detectCurrency(allText);

    offerTypes = [
      {
        key: kind === "service" ? "service" : "product",
        name: kind === "service" ? "Services" : "Products",
        kind,
        attributes: attrs.map((a) => a.def),
      },
    ];

    let unpriced = 0;
    let noCurrency = 0;
    offers = catalog.rows.map((row) => {
      const cell = (i: number | undefined) => (i === undefined ? "" : clean(row[i]));
      const price = priceCol === undefined ? null : parsePrice(cell(priceCol));
      const currency =
        detectCurrency(cell(currencyCol)) ??
        cell(currencyCol).match(/^[A-Z]{3}$/)?.[0] ??
        detectCurrency(cell(priceCol)) ??
        defaultCurrency;
      const priced = price !== null && currency !== null;
      if (price === null) unpriced++;
      else if (currency === null) noCurrency++;
      const attributes: Record<string, AttributeValue> = {};
      for (const { def, col: c } of attrs) {
        const value = attributeValue(def, row[c] ?? "");
        if (value !== null) attributes[def.key] = value;
      }
      const image = cell(imageCol);
      return {
        title: cell(titleCol).slice(0, 200),
        description: cell(descriptionCol),
        category: cell(categoryCol) || null,
        offer_type: offerTypes[0]!.key,
        attributes,
        price: priced ? price : null,
        currency: priced ? currency : null,
        price_status: priced ? "confirmed" : "on_request",
        availability:
          availabilityCol === undefined ? "unknown" : parseAvailability(cell(availabilityCol)),
        image_url: /^https:\/\/\S+$/.test(image) ? image : null,
      };
    });

    if (noCurrency > 0) {
      missing.push({
        field: "offers.currency",
        question:
          "Which currency are your prices in? They are shown as price on request until then.",
        severity: "recommended",
      });
    }
    if (unpriced > 0) {
      missing.push({
        field: "offers.price",
        question: `${unpriced} ${unpriced === 1 ? "offer has" : "offers have"} no price. Add prices or keep them on request.`,
        severity: "recommended",
      });
    }
  } else {
    missing.push({
      field: "offers",
      question:
        "We could not find a product or service list. Upload a price list or add offers later.",
      severity: "recommended",
    });
  }

  const description = describe(sources.texts);
  if (!Object.values(contacts).some(Boolean)) {
    missing.push({
      field: "profile.contacts",
      question: "How can customers reach you? Add a phone, email, messenger or website.",
      severity: "blocking",
    });
  }
  for (const [field, question] of Object.entries(POLICY_QUESTIONS)) {
    if (question && policies[field as keyof PoliciesDraft] === null) {
      missing.push({ field: `policies.${field}`, question, severity: "recommended" });
    }
  }

  return {
    profile: {
      name: sources.businessName.trim(),
      description,
      category: null,
      contacts,
    },
    offer_types: offerTypes,
    offers,
    policies,
    missing_info: missing,
  };
}
