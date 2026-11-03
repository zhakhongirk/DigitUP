/**
 * Rule-based stand-in for the language model, used when no LLM is configured.
 * It is stateless: every decision is derived from the conversation history it
 * is given, and it acts only through the Customer Agent's own tools, so
 * messages, inquiries and orders follow the same path as with a real model.
 */
import { randomUUID } from "node:crypto";
import type { LlmChatRequest, LlmChatResult, LlmClient, LlmMessage } from "@/server/llm";

export type Lang = "en" | "ru";
export type InfoTopic =
  "hours" | "delivery" | "payment" | "returns" | "address" | "contact" | "general";
export type IntentKind =
  | "greeting"
  | "help"
  | "human"
  | "buy"
  | "info"
  | "price"
  | "stock"
  | "search"
  | "yes"
  | "no"
  | "contact";

export interface ShopperContact {
  name?: string;
  phone?: string;
  email?: string;
}

export interface Intent {
  kind: IntentKind;
  lang: Lang;
  terms: string[];
  topic: InfoTopic | null;
  quantity: number;
  size: string | null;
  contact: ShopperContact;
}

const STOPWORDS = new Set(
  (
    "a an the do does did you have has any got is are was there what which how much many cost costs price prices " +
    "of for in on at to me i we my your our it its this that these those please show shows find looking look " +
    "want need can could would like some with and or buy order purchase get stock available availability " +
    "call size sizes tell about about from by be am just also pair pairs pcs piece pieces item items thanks thank " +
    "у вас есть ли покажи покажите показать найди найдите ищу ищем хочу хотел хотела нужен нужна нужно нужны " +
    "сколько стоит стоят цена цены цену какая какой какие какое наличии наличие в на для по и или мне можно " +
    "пожалуйста купить куплю заказать заказ размер размеры это эти та то там что где как не а но с со из " +
    "от до вы ты мы я он она они их ваш ваши шт штук пара пар спасибо подскажите скажите размера размере размеров"
  ).split(/\s+/),
);

const EMAIL_RE = /[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+/;
const PHONE_RE = /\+?\d[\d\s().-]{5,}\d/;
const NAME_RE =
  /(?<![\p{L}])(?:[Mm]y name is|[Ii]'m|I am|[Мм]еня зовут|[Мм]о[её] имя|[Ээ]то)\s+(\p{Lu}[\p{L}'-]*(?:\s+\p{Lu}[\p{L}'-]*)?)/u;
const SIZE_RE =
  /(?<![\p{L}])(?:(?:size|sz|eu|us|uk|размер)\s*[:#-]?\s*(\d{1,3}(?:[.,]\d)?)|(\d{2}(?:[.,]\d)?)\s*-?\s*(?:го\s+)?(?:размер\p{L}*|size))/iu;
const BARE_SIZE_RE = /^\s*(\d{2}(?:[.,]5)?)\s*$/;
const QUANTITY_RES = [
  /(\d{1,2})\s*(?:pcs|pieces|piece|pairs?|units?|шт|штук|штуки|пар|пары)(?![\p{L}])/iu,
  /(?:buy|order|take|купить|заказать|беру|возьму)\s+(\d{1,2})(?=\s)/iu,
  /(?:^|\s)x\s?(\d{1,2})(?=$|[\s,.!?])/i,
];
const PICKUP_RE =
  /(?<![\p{L}])(?:pick\s?-?up|collect|self[- ]?pickup|самовывоз\p{L}*|заберу|забрать)/iu;
const DELIVERY_RE =
  /(?<![\p{L}])(?:deliver\p{L}*|ship\p{L}*|courier|доставк\p{L}*|доставьте|курьер\p{L}*|привез\p{L}*)/iu;
const ADDRESS_RE =
  /(?:(?:deliver\p{L}*|ship\p{L}*)\s+(?:to|at)|(?:доставк\p{L}*|доставьте)\s+(?:на|по|в)|(?<![\p{L}])(?:address|адрес))\s*[:-]?\s*(\S.{3,})$/iu;
const END = "(?=$|[\\s,.!?])";

const YES_RE = new RegExp(
  `^\\W*(yes|yeah|yep|yup|ok|okay|sure|confirm|confirmed|go ahead|please do|да|ага|угу|ок|окей|давай|давайте|конечно|подтверждаю|подтвердить|оформляй|оформляйте|оформите)${END}`,
  "i",
);
const NO_RE = new RegExp(
  `^\\W*(no|nope|nah|cancel|not now|нет|не надо|не нужно|отмена|отменить|не сейчас|потом)${END}`,
  "i",
);
const GREETING_RE = new RegExp(
  `^\\W*(hi|hello|hey|hola|good (morning|afternoon|evening)|привет|здравствуй|здравствуйте|добрый|салам|сәлем)${END}`,
  "i",
);
const HELP_RE =
  /\b(help|what can you|how does this work)\b|помощь|помоги|что (ты )?умеешь|что можешь/i;
const HUMAN_RE =
  /\b(owner|human|real person|talk to a person|manager|operator|staff|someone|seller|representative|call me|contact me)\b|владел|человек|менеджер|оператор|продав|сотрудник|живой|перезвон|свяжитесь|связаться со/i;
const BUY_RE =
  /\b(buy|purchase|order|i'll take|ill take|checkout)\b|куп(ить|лю|и)(?![\p{L}])|заказат|оформ|беру|возьму/iu;
const TRACK_RE = /\b(status|track|tracking)\b|статус|отследить|где мой/i;
const PRICE_RE =
  /\b(how much|price|prices|cost|costs|cheap|cheaper|expensive)\b|сколько|цен[аыуе]|почём|стоим|стоит|стоят/i;
const STOCK_RE =
  /\b(in stock|available|availability|sizes?|left)\b|в налич|наличие|остал|размер|есть ли в/i;

const TOPIC_RES: [InfoTopic, RegExp, RegExp][] = [
  [
    "hours",
    /\b(opening hours|working hours|business hours|opening times|are you open|open now|open today|when do you (open|close)|when are you open)\b|часы работы|режим работы|график работы|работаете/i,
    /\b(hours|opening|closing|schedule|working time)\b|режим|график|открыт/i,
  ],
  ["delivery", /\b(deliver\w*|shipping|ship)\b|доставк|привез|курьер/i, /(?!)/],
  [
    "payment",
    /\b(pay|payment|payments|pay by card|by card|card payment|cash|kaspi|installment)\b|оплат|налич(н|ным)|рассрочк/i,
    /карт/i,
  ],
  [
    "returns",
    /\b(return policy|refunds?)\b|возврат/i,
    /\b(return|returns|exchange|warranty)\b|обмен|гарант/i,
  ],
  [
    "address",
    /\b(address|where are you|directions)\b|адрес|где наход|как добраться|где вы/i,
    /\b(located|location)\b/i,
  ],
  [
    "contact",
    /\b(phone number|contact details|whatsapp|telegram|instagram|email address)\b|контакты|номер телефона/i,
    /\b(phone|call|contact|contacts|email)\b|телефон|позвон|номер|контакт|написать/i,
  ],
  ["general", /\b(about (the )?(store|shop)|who are you)\b|о магазин|о вас|кто вы/i, /(?!)/],
];

function matchTopic(text: string): InfoTopic | null {
  for (const [topic, strong] of TOPIC_RES) {
    if (strong.test(text)) return topic;
  }
  for (const [topic, , weak] of TOPIC_RES) {
    const match = weak.exec(text);
    if (match && searchTerms(text.replace(match[0], " ")).length === 0) return topic;
  }
  return null;
}

function messageLang(text: string): Lang | null {
  if (!/\p{L}/u.test(text)) return null;
  return /[а-яё]/i.test(text) ? "ru" : "en";
}

function detectLang(text: string): Lang {
  return messageLang(text) ?? "en";
}

/**
 * Language of the shopper's side of the chat. Messages without letters (phone
 * numbers, digits, emoji) say nothing about language and are skipped. The
 * dominant language wins; on a tie the latest letter-bearing message decides.
 */
export function conversationLang(texts: string[]): Lang {
  const counts: Record<Lang, number> = { en: 0, ru: 0 };
  let latest: Lang | null = null;
  for (const text of texts) {
    const lang = messageLang(text);
    if (!lang) continue;
    counts[lang] += 1;
    latest = lang;
  }
  if (counts.ru === counts.en) return latest ?? "en";
  return counts.ru > counts.en ? "ru" : "en";
}

function wordCount(text: string): number {
  return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean).length;
}

function stem(word: string): string {
  if (/[а-яё]/.test(word)) {
    if (word.length >= 6) return word.slice(0, -2);
    if (word.length === 5) return word.slice(0, -1);
    return word;
  }
  return word.length > 4 && word.endsWith("s") ? word.slice(0, -1) : word;
}

export function searchTerms(text: string): string[] {
  const terms: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}-]+/u)) {
    const word = raw.replace(/^-+|-+$/g, "");
    if (word.length < 2 || STOPWORDS.has(word) || /^\d+$/.test(word)) continue;
    const term = stem(word);
    if (!terms.includes(term)) terms.push(term);
  }
  return terms.slice(0, 6);
}

const RU_EN: [string, string[]][] = [
  ["кроссов", ["sneaker", "shoe"]],
  ["кед", ["sneaker", "shoe"]],
  ["ботин", ["boot", "shoe"]],
  ["сапог", ["boot"]],
  ["туфл", ["shoe"]],
  ["сандал", ["sandal"]],
  ["босонож", ["sandal"]],
  ["лофер", ["loafer"]],
  ["обув", ["shoe"]],
  ["бег", ["running"]],
  ["детск", ["kids"]],
  ["женск", ["women"]],
  ["мужск", ["men"]],
  ["зимн", ["winter"]],
  ["летн", ["summer"]],
  ["кожан", ["leather"]],
  ["стриж", ["haircut"]],
  ["бород", ["beard"]],
  ["брит", ["shave"]],
  ["окраш", ["coloring"]],
  ["укладк", ["styling"]],
  ["красн", ["red"]],
  ["син", ["blue"]],
  ["голуб", ["blue"]],
  ["зелен", ["green"]],
  ["черн", ["black"]],
  ["бел", ["white"]],
  ["сер", ["gray"]],
  ["желт", ["yellow"]],
  ["коричн", ["brown"]],
  ["бежев", ["beige"]],
  ["розов", ["pink"]],
  ["оранж", ["orange"]],
  ["фиолет", ["purple"]],
];

function translateTerm(term: string): string[] | null {
  const t = term.replace(/ё/g, "е");
  if (!/[а-я]/.test(t)) return null;
  for (const [key, english] of RU_EN) {
    if (t.startsWith(key) && t.length <= key.length + (key.length >= 5 ? 5 : 2)) return english;
  }
  return null;
}

export function englishTerms(terms: string[]): { primary: string[]; all: string[] } {
  const primary: string[] = [];
  const all: string[] = [];
  for (const term of terms) {
    const english = translateTerm(term);
    const first = english?.[0] ?? term;
    if (!primary.includes(first)) primary.push(first);
    for (const word of english ?? [term]) if (!all.includes(word)) all.push(word);
  }
  return { primary, all };
}

function shopperSize(intent: Intent, userMessages: string[]): string | null {
  if (intent.size) return intent.size;
  for (const message of [...userMessages].reverse()) {
    const size = parseIntent(message).size ?? BARE_SIZE_RE.exec(message)?.[1]?.replace(",", ".");
    if (size) return size;
  }
  return null;
}

function matchName(text: string): { value: string; phrase: string } | null {
  const match = NAME_RE.exec(text);
  return match?.[1] ? { value: match[1], phrase: match[0] } : null;
}

function extractContact(text: string): { contact: ShopperContact; rest: string } {
  const contact: ShopperContact = {};
  let rest = text;
  const email = EMAIL_RE.exec(rest);
  if (email) {
    contact.email = email[0];
    rest = rest.replace(email[0], " ");
  }
  const phone = PHONE_RE.exec(rest);
  if (phone) {
    const digits = phone[0].replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15) {
      contact.phone = phone[0].trim();
      rest = rest.replace(phone[0], " ");
    }
  }
  const name = matchName(rest);
  if (name) {
    contact.name = name.value;
    rest = rest.replace(name.phrase, " ");
  }
  return { contact, rest };
}

export function parseIntent(input: string): Intent {
  const text = input.trim();
  const lang = detectLang(text);
  const { contact, rest: withoutContact } = extractContact(text);

  let rest = withoutContact;
  const sizeMatch = SIZE_RE.exec(rest);
  const size = sizeMatch ? (sizeMatch[1] ?? sizeMatch[2] ?? "").replace(",", ".") : null;
  if (sizeMatch) rest = rest.replace(sizeMatch[0], " ");
  let quantity = 1;
  for (const re of QUANTITY_RES) {
    const match = re.exec(rest);
    if (match) {
      quantity = Math.min(Math.max(Number(match[1]), 1), 20);
      rest = rest.replace(match[0], " ");
      break;
    }
  }

  const terms = searchTerms(rest);
  const base = { lang, terms, topic: null, quantity, size, contact } satisfies Omit<Intent, "kind">;
  const short = wordCount(withoutContact) <= 4;

  if (short && YES_RE.test(withoutContact)) return { ...base, kind: "yes", terms: [] };
  if (short && NO_RE.test(withoutContact)) return { ...base, kind: "no", terms: [] };
  if (HUMAN_RE.test(text)) return { ...base, kind: "human", terms: [] };
  const hasContact = contact.phone !== undefined || contact.email !== undefined;
  if (hasContact && wordCount(withoutContact) <= 4) return { ...base, kind: "contact", terms: [] };
  if (BUY_RE.test(text) && !TRACK_RE.test(text)) return { ...base, kind: "buy" };

  const topic = matchTopic(text);
  if (topic) return { ...base, kind: "info", topic, terms: [] };
  if (PRICE_RE.test(text)) return { ...base, kind: "price" };
  if (STOCK_RE.test(text)) return { ...base, kind: "stock" };
  if (short && GREETING_RE.test(text)) return { ...base, kind: "greeting", terms: [] };
  if (HELP_RE.test(text)) return { ...base, kind: "help", terms: [] };
  return { ...base, kind: "search" };
}

const COPY = {
  en: {
    help:
      "I can find products, check prices and availability, answer questions about delivery, payment and " +
      "returns, or pass a question to the store owner. What are you looking for?",
    greeting: "Hi! ",
    noMatch: "I could not find that in the catalog.",
    found: "Here is what I found:",
    more: (n: number) => `...and ${n} more. Tell me a bit more to narrow it down.`,
    priceOnRequest: "Price on request",
    availability: {
      in_stock: "in stock",
      out_of_stock: "out of stock",
      unknown: "availability to be confirmed",
    },
    sizes: (list: string) => `sizes: ${list}`,
    sizeYes: (size: string) => `size ${size} is listed`,
    sizeNo: (size: string) => `size ${size} is not listed`,
    handoff:
      "Would you like me to pass this to the store owner? Reply yes, or send a phone number or email so they can reach you.",
    inquirySent: "Done, your question was sent to the store owner. They will reply to you.",
    addContact: "Send a phone number or email in your next message so they can reach you directly.",
    contactSent: "Thanks, I passed your contact details to the store owner.",
    declined: "Okay, I will not send it. Anything else I can help with?",
    topicLabel: {
      hours: "working hours",
      delivery: "delivery terms",
      payment: "payment options",
      returns: "return policy",
      address: "the address",
      contact: "contact details",
      general: "store details",
    },
    topicMissing: (label: string) => `The store has not confirmed ${label} yet.`,
    topicHeading: (label: string) => label.charAt(0).toUpperCase() + label.slice(1),
    contactsLine: "You can reach the store here",
    which: "Which one would you like to order? Tell me the name.",
    notOrderable: (title: string, why: string) =>
      `${title} cannot be ordered online right now (${why}).`,
    orderDraft: (lines: string, total: string) =>
      `Your order: ${lines}. Total ${total}. It is not placed yet.`,
    orderPrompt:
      'To place it, press "Confirm order" below, or tell me your name, phone number and whether you want pickup or delivery (with the address). Reply no to cancel.',
    orderSize: (size: string) => `Size: ${size}.`,
    sizeAsk: (list: string) => `Which size? Available: ${list}.`,
    askName: "What is your name?",
    askPhone: "What phone number can the store reach you at?",
    askFulfillment: "Would you like pickup or delivery?",
    askAddress: "What is the delivery address?",
    orderSent: "Your order was sent to the store. The owner will contact you to confirm it.",
    orderCancelled: "Okay, I did not place the order. Nothing was sent.",
    orderError:
      "I could not place that order. It may already be sent; check the order card, or contact the store directly.",
    orderWaiting: 'To place the order, tell me your details, or press "Confirm order" below.',
    error: "Sorry, I could not do that right now. Please try again, or contact the store directly.",
    askOwner: "Of course.",
    askProduct: "Which product do you mean? Tell me its name or what you are looking for.",
  },
  ru: {
    help:
      "Я могу найти товары, подсказать цены и наличие, ответить про доставку, оплату и возврат " +
      "или передать вопрос владельцу магазина. Что вас интересует?",
    greeting: "Здравствуйте! ",
    noMatch: "Не нашёл этого в каталоге.",
    found: "Вот что нашлось:",
    more: (n: number) => `...и ещё ${n}. Уточните запрос, чтобы сузить выбор.`,
    priceOnRequest: "Цена по запросу",
    availability: {
      in_stock: "в наличии",
      out_of_stock: "нет в наличии",
      unknown: "наличие уточняется",
    },
    sizes: (list: string) => `размеры: ${list}`,
    sizeYes: (size: string) => `размер ${size} есть в списке`,
    sizeNo: (size: string) => `размера ${size} нет в списке`,
    handoff:
      "Передать это владельцу магазина? Ответьте да или отправьте телефон или почту, чтобы с вами связались.",
    inquirySent: "Готово, ваш вопрос отправлен владельцу магазина. Он ответит вам.",
    addContact:
      "Отправьте следующим сообщением телефон или почту, чтобы с вами можно было связаться.",
    contactSent: "Спасибо, передал ваши контакты владельцу магазина.",
    declined: "Хорошо, не отправляю. Чем ещё помочь?",
    topicLabel: {
      hours: "часы работы",
      delivery: "условия доставки",
      payment: "способы оплаты",
      returns: "условия возврата",
      address: "адрес",
      contact: "контакты",
      general: "информацию о магазине",
    },
    topicMissing: (label: string) => `Магазин пока не подтвердил: ${label}.`,
    topicHeading: (label: string) => label.charAt(0).toUpperCase() + label.slice(1),
    contactsLine: "Связаться с магазином можно здесь",
    which: "Какой именно товар заказать? Напишите название.",
    notOrderable: (title: string, why: string) =>
      `${title} сейчас нельзя заказать онлайн (${why}).`,
    orderDraft: (lines: string, total: string) =>
      `Ваш заказ: ${lines}. Итого ${total}. Он ещё не оформлен.`,
    orderPrompt:
      "Чтобы оформить, нажмите «Подтвердить заказ» ниже или напишите имя, телефон и что вам удобнее: самовывоз или доставка (с адресом). Ответьте нет, чтобы отменить.",
    orderSize: (size: string) => `Размер: ${size}.`,
    sizeAsk: (list: string) => `Какой размер? Есть: ${list}.`,
    askName: "Как вас зовут?",
    askPhone: "На какой номер телефона магазин может вам позвонить?",
    askFulfillment: "Вам нужен самовывоз или доставка?",
    askAddress: "Какой адрес доставки?",
    orderSent: "Заказ отправлен в магазин. Владелец свяжется с вами для подтверждения.",
    orderCancelled: "Хорошо, заказ не оформлен. Ничего не отправлено.",
    orderError:
      "Не удалось оформить заказ. Возможно, он уже отправлен; проверьте карточку заказа или свяжитесь с магазином.",
    orderWaiting:
      "Чтобы оформить заказ, напишите свои данные или нажмите «Подтвердить заказ» ниже.",
    error: "Извините, сейчас не получилось. Попробуйте ещё раз или свяжитесь с магазином напрямую.",
    askOwner: "Конечно.",
    askProduct: "О каком товаре речь? Напишите название или что вы ищете.",
  },
} as const;

type Copy = (typeof COPY)[Lang];

const SIZE_ASK_RE = /^(?:Which size\? Available|Какой размер\? Есть): (.+)\.$/u;

type AskKind = "name" | "phone" | "fulfillment" | "address";
type PromptKey =
  | "handoff"
  | "addContact"
  | "orderPrompt"
  | "askName"
  | "askPhone"
  | "askFulfillment"
  | "askAddress";

const ASKS: [AskKind, PromptKey][] = [
  ["name", "askName"],
  ["phone", "askPhone"],
  ["fulfillment", "askFulfillment"],
  ["address", "askAddress"],
];

function endsWithPrompt(text: string, key: PromptKey): boolean {
  return text.endsWith(COPY.en[key]) || text.endsWith(COPY.ru[key]);
}

function askingOf(text: string): AskKind | null {
  return ASKS.find(([, key]) => endsWithPrompt(text, key))?.[0] ?? null;
}

export interface OrderDetails {
  name?: string;
  phone?: string;
  email?: string;
  fulfillment?: "pickup" | "delivery";
  address?: string;
}

function parseOrderDetails(text: string, asking: AskKind | null, inOrder: boolean): OrderDetails {
  const { contact, rest } = extractContact(text);
  const details: OrderDetails = { ...contact };
  const clean = rest.replace(/\s+/g, " ").trim();
  if (inOrder || asking) {
    if (PICKUP_RE.test(clean)) details.fulfillment = "pickup";
    else if (DELIVERY_RE.test(clean)) details.fulfillment = "delivery";
    const inline = ADDRESS_RE.exec(clean)?.[1]?.trim();
    if (inline) {
      details.address = inline.slice(0, 500);
      details.fulfillment ??= "delivery";
    }
  }
  if (asking === "address" && !details.address && clean && !PICKUP_RE.test(clean)) {
    details.address = clean.slice(0, 500);
    details.fulfillment = "delivery";
  }
  if (
    asking === "name" &&
    !details.name &&
    clean &&
    !details.fulfillment &&
    !/[\d?]/.test(clean) &&
    wordCount(clean) <= 4 &&
    !YES_RE.test(clean) &&
    !NO_RE.test(clean)
  ) {
    details.name = clean
      .replace(/[.,!;]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
  }
  return details;
}

function mergeDetails(base: OrderDetails, next: OrderDetails): OrderDetails {
  const merged = { ...base };
  for (const [key, value] of Object.entries(next)) {
    if (value) (merged as Record<string, string>)[key] = value;
  }
  return merged;
}

interface ShownOffer {
  offer_id: string;
  title: string;
  price_status?: string;
  price_label?: string;
  availability?: "in_stock" | "out_of_stock" | "unknown";
  can_order?: boolean;
  attributes?: Record<string, unknown>;
}

export type Pending =
  | { kind: "handoff"; question: string }
  | { kind: "size"; offerId: string; quantity: number; sizes: string[] }
  | { kind: "inquiry_sent" }
  | {
      kind: "order";
      key: string;
      items: { offer_id: string; quantity: number }[];
      asking: AskKind | null;
      details: OrderDetails;
    };

export interface FallbackContext {
  pending: Pending | null;
  lastOffer: ShownOffer | null;
  userMessages: string[];
}

interface ToolBatch {
  calls: { name: string; arguments: Record<string, unknown> }[];
  results: { name: string; data: unknown }[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function messageText(message: LlmMessage | undefined): string {
  if (!message || message.role === "tool" || message.role === "system") return "";
  if (typeof message.content === "string") return message.content;
  if (message.content === null) return "";
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join(" ");
}

function readBatches(messages: LlmMessage[]): ToolBatch[] {
  const batches: ToolBatch[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls?.length) {
      batches.push({
        calls: message.toolCalls.map((call) => ({ name: call.name, arguments: call.arguments })),
        results: [],
      });
    } else if (message.role === "tool") {
      batches.at(-1)?.results.push({ name: message.name, data: parseJson(message.content) });
    }
  }
  return batches;
}

function offersOf(batch: ToolBatch): ShownOffer[] {
  const found = new Map<string, ShownOffer>();
  for (const result of batch.results) {
    const data = asRecord(result.data);
    if (!data) continue;
    const list = Array.isArray(data.offers) ? data.offers : [data];
    for (const item of list) {
      const offer = asRecord(item);
      if (offer && typeof offer.offer_id === "string" && typeof offer.title === "string") {
        found.set(offer.offer_id, offer as unknown as ShownOffer);
      }
    }
  }
  return [...found.values()];
}

function collectDetails(history: LlmMessage[]): OrderDetails {
  let details: OrderDetails = {};
  let previous = "";
  let inOrder = false;
  for (const message of history) {
    if (message.role === "assistant" && !message.toolCalls?.length) {
      const text = messageText(message);
      if (!text) continue;
      previous = text;
      if (endsWithPrompt(text, "orderPrompt") || askingOf(text) !== null) inOrder = true;
      else if (text === COPY.en.orderSent || text === COPY.ru.orderSent) inOrder = false;
      else if (text === COPY.en.orderCancelled || text === COPY.ru.orderCancelled) inOrder = false;
    } else if (message.role === "user") {
      details = mergeDetails(
        details,
        parseOrderDetails(messageText(message), askingOf(previous), inOrder),
      );
    }
  }
  return details;
}

export function readContext(history: LlmMessage[]): FallbackContext {
  const batches = readBatches(history);
  let lastOffer: ShownOffer | null = null;
  for (const batch of batches) {
    if (!batch.calls.some((c) => c.name === "search_offers" || c.name === "get_offer_details")) {
      continue;
    }
    const offers = offersOf(batch);
    lastOffer = offers.length === 1 ? (offers[0] ?? null) : null;
  }

  const userMessages = history.filter((m) => m.role === "user").map(messageText);
  let lastIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m?.role === "assistant" && !m.toolCalls?.length && messageText(m)) {
      lastIndex = i;
      break;
    }
  }
  const lastText = lastIndex >= 0 ? messageText(history[lastIndex]) : "";

  let pending: Pending | null = null;
  const sizeAsk = SIZE_ASK_RE.exec(lastText);
  if (sizeAsk?.[1]) {
    const listed = sizeAsk[1];
    const offer = [...batches]
      .reverse()
      .flatMap((b) => offersOf(b))
      .find((o) => {
        const sizes = o.attributes?.sizes;
        return Array.isArray(sizes) && sizes.map(String).join(", ") === listed;
      });
    const buy = [...userMessages]
      .reverse()
      .map(parseIntent)
      .find((i) => i.kind === "buy");
    if (offer) {
      pending = {
        kind: "size",
        offerId: offer.offer_id,
        quantity: buy?.quantity ?? 1,
        sizes: listed.split(", "),
      };
    }
  } else if (endsWithPrompt(lastText, "handoff")) {
    const before = history.slice(0, lastIndex).filter((m) => m.role === "user");
    pending = { kind: "handoff", question: messageText(before.at(-1)) };
  } else if (endsWithPrompt(lastText, "addContact")) {
    pending = { kind: "inquiry_sent" };
  } else if (endsWithPrompt(lastText, "orderPrompt") || askingOf(lastText) !== null) {
    const create = batches.filter((b) => b.calls.some((c) => c.name === "create_order")).at(-1);
    const args = create?.calls.find((c) => c.name === "create_order")?.arguments;
    const key = typeof args?.idempotency_key === "string" ? args.idempotency_key : null;
    if (key && Array.isArray(args?.items)) {
      pending = {
        kind: "order",
        key,
        items: args.items as { offer_id: string; quantity: number }[],
        asking: askingOf(lastText),
        details: collectDetails(history),
      };
    }
  }
  return { pending, lastOffer, userMessages };
}

export type Decision =
  { reply: string } | { calls: { name: string; arguments: Record<string, unknown> }[] };

function contactArg(contact: ShopperContact): Record<string, unknown> {
  return {
    ...(contact.name ? { name: contact.name } : {}),
    ...(contact.phone ? { phone: contact.phone } : {}),
    ...(contact.email ? { email: contact.email } : {}),
  };
}

function hasContact(contact: ShopperContact): boolean {
  return Boolean(contact.name || contact.phone || contact.email);
}

function inquiryCall(question: string, ctx: FallbackContext, contact: ShopperContact): Decision {
  const subject = (
    question.trim() ||
    ctx.userMessages.at(-1) ||
    "Question from the store chat"
  ).slice(0, 300);
  const details = ctx.userMessages.slice(-3).join("\n").slice(0, 5000);
  return {
    calls: [
      {
        name: "submit_inquiry",
        arguments: {
          subject,
          details,
          ...(hasContact(contact) ? { contact: contactArg(contact) } : {}),
        },
      },
    ],
  };
}

function handoffText(copy: Copy): string {
  return copy.handoff;
}

function priceOf(offer: ShownOffer, copy: Copy): string {
  return offer.price_status === "confirmed" && offer.price_label
    ? offer.price_label
    : copy.priceOnRequest;
}

function availabilityOf(offer: ShownOffer, copy: Copy): string {
  return copy.availability[offer.availability ?? "unknown"];
}

function sizeNote(offer: ShownOffer, intent: Intent, copy: Copy): string | null {
  const sizes = offer.attributes?.sizes;
  if (!Array.isArray(sizes) || sizes.length === 0) return null;
  const list = sizes.map(String);
  if (intent.size)
    return list.includes(intent.size) ? copy.sizeYes(intent.size) : copy.sizeNo(intent.size);
  return intent.kind === "stock" ? copy.sizes(list.join(", ")) : null;
}

function offerLine(offer: ShownOffer, intent: Intent, copy: Copy): string {
  const parts: string[] = [];
  if (intent.kind !== "stock") parts.push(priceOf(offer, copy));
  if (intent.kind !== "price") parts.push(availabilityOf(offer, copy));
  const size = intent.kind === "price" ? null : sizeNote(offer, intent, copy);
  if (size) parts.push(size);
  return `- ${offer.title}: ${parts.join(", ")}`;
}

const MAX_LISTED = 5;

function offersReply(offers: ShownOffer[], total: number, intent: Intent, copy: Copy): string {
  if (offers.length === 0) return `${copy.noMatch} ${handoffText(copy)}`;
  const lines = offers.slice(0, MAX_LISTED).map((offer) => offerLine(offer, intent, copy));
  const extra = total - lines.length;
  const lead = copy.found;
  const body = [lead, ...lines, ...(extra > 0 ? [copy.more(extra)] : [])].join("\n");
  const unpriced = intent.kind === "price" && offers.some((o) => o.price_status !== "confirmed");
  return unpriced ? `${body}\n${handoffText(copy)}` : body;
}

function pickOffer(offers: ShownOffer[], terms: string[]): ShownOffer | null {
  if (offers.length === 1) return offers[0] ?? null;
  const exact = offers.filter(
    (o) => terms.length > 0 && terms.every((t) => o.title.toLowerCase().includes(t)),
  );
  return exact.length === 1 ? (exact[0] ?? null) : null;
}

function stripLabel(topic: InfoTopic, value: string): string {
  const match = /^([^\n:]{2,40}):\s+(\S[\s\S]*)$/u.exec(value);
  const re = TOPIC_RES.find(([key]) => key === topic)?.[1];
  return match && re?.test(match[1] ?? "") ? (match[2] ?? value) : value;
}

function infoReply(topic: InfoTopic, data: unknown, copy: Copy): string {
  const record = asRecord(data);
  if (!record) return copy.error;
  const policies = asRecord(record.policies) ?? {};
  const contacts = asRecord(record.contacts) ?? {};
  const known = (value: unknown): string | null =>
    typeof value === "string" && value.trim() !== "" && value !== "To be confirmed" ? value : null;

  const label = copy.topicLabel[topic];
  let value: string | null = null;
  switch (topic) {
    case "hours":
      value = known(policies.working_hours);
      break;
    case "delivery":
      value = known(policies.delivery);
      break;
    case "payment":
      value = known(policies.payment);
      break;
    case "returns":
      value = known(policies.returns);
      break;
    case "address":
      value = known(contacts.address);
      break;
    case "contact": {
      const channels = ["phone", "email", "whatsapp", "telegram", "instagram", "website"]
        .map((key) => [key, known(contacts[key])] as const)
        .filter((entry): entry is readonly [string, string] => entry[1] !== null)
        .map(([key, v]) => `${key}: ${v}`);
      value = channels.length > 0 ? channels.join("\n") : null;
      break;
    }
    case "general": {
      const description = known(record.description);
      const categories = Array.isArray(record.categories)
        ? record.categories.filter((c): c is string => typeof c === "string")
        : [];
      const parts = [
        known(record.name),
        description,
        categories.length ? categories.join(", ") : null,
      ];
      const text = parts.filter(Boolean).join(". ");
      value = text || null;
      break;
    }
  }
  if (value === null) return `${copy.topicMissing(label)} ${handoffText(copy)}`;
  return `${copy.topicHeading(label)}: ${stripLabel(topic, value)}`;
}

function orderSummary(data: Record<string, unknown>, copy: Copy, size: string | null): string {
  const items = Array.isArray(data.items) ? data.items : [];
  const lines = items
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => `${String(item.title)} x ${String(item.quantity)}`)
    .join(", ");
  const total = typeof data.total_label === "string" ? data.total_label : copy.priceOnRequest;
  const sizeLine = size ? ` ${copy.orderSize(size)}` : "";
  return `${copy.orderDraft(lines, total)}${sizeLine} ${copy.orderPrompt}`;
}

function resultOf(batch: ToolBatch, name: string): { data: unknown } | null {
  return batch.results.find((r) => r.name === name) ?? null;
}

function noteArg(size: string | null): Record<string, unknown> {
  return size ? { note: `Size: ${size}` } : {};
}

function orderStep(
  pending: Extract<Pending, { kind: "order" }>,
  intent: Intent,
  text: string,
  ctx: FallbackContext,
): Decision {
  const copy = COPY[intent.lang];
  const details = mergeDetails(pending.details, parseOrderDetails(text, pending.asking, true));
  const ask = !details.name
    ? copy.askName
    : !details.phone
      ? copy.askPhone
      : !details.fulfillment
        ? copy.askFulfillment
        : details.fulfillment === "delivery" && !details.address
          ? copy.askAddress
          : null;
  if (ask) return { reply: ask };
  const contact = {
    ...contactArg(details),
    ...noteArg(shopperSize(intent, ctx.userMessages)),
  };
  return {
    calls: [
      {
        name: "create_order",
        arguments: {
          idempotency_key: pending.key,
          items: pending.items,
          submit: true,
          contact,
          fulfillment: details.fulfillment,
          ...(details.fulfillment === "delivery" ? { delivery_address: details.address } : {}),
        },
      },
    ],
  };
}

function startDecision(intent: Intent, ctx: FallbackContext, text: string, key: string): Decision {
  const copy = COPY[intent.lang];
  const { pending } = ctx;
  if (pending?.kind === "size") {
    const size = intent.size ?? BARE_SIZE_RE.exec(text)?.[1]?.replace(",", ".") ?? null;
    if (size && pending.sizes.includes(size)) {
      return {
        calls: [
          {
            name: "create_order",
            arguments: {
              idempotency_key: key,
              items: [{ offer_id: pending.offerId, quantity: pending.quantity }],
              submit: false,
              contact: noteArg(size),
            },
          },
        ],
      };
    }
    if (size) return { reply: copy.sizeAsk(pending.sizes.join(", ")) };
    if (intent.kind === "no") return { reply: copy.orderCancelled };
  }
  if (pending?.kind === "order" && intent.kind !== "no") {
    const fresh = parseOrderDetails(text, pending.asking, true);
    if (intent.kind === "yes" || intent.kind === "contact" || Object.keys(fresh).length > 0) {
      return orderStep(pending, intent, text, ctx);
    }
  }
  switch (intent.kind) {
    case "greeting":
      return { reply: `${copy.greeting}${copy.help}` };
    case "help":
      return { reply: copy.help };
    case "yes":
      if (pending?.kind === "handoff") return inquiryCall(pending.question, ctx, intent.contact);
      return { reply: copy.help };
    case "no":
      if (pending?.kind === "order") return { reply: copy.orderCancelled };
      if (pending?.kind === "handoff") return { reply: copy.declined };
      return { reply: copy.help };
    case "contact":
      if (pending?.kind === "handoff") return inquiryCall(pending.question, ctx, intent.contact);
      if (pending?.kind === "inquiry_sent") {
        return inquiryCall("Contact details for the previous question", ctx, intent.contact);
      }
      if (pending?.kind === "order") return { reply: copy.orderWaiting };
      return inquiryCall(ctx.userMessages.at(-1) ?? "", ctx, intent.contact);
    case "human":
      if (hasContact(intent.contact)) {
        const question = ctx.userMessages.at(-1) ?? text;
        return inquiryCall(
          question,
          { ...ctx, userMessages: [...ctx.userMessages, text] },
          intent.contact,
        );
      }
      return { reply: `${copy.askOwner} ${handoffText(copy)}` };
    case "info":
      return { calls: [{ name: "get_business_info", arguments: {} }] };
    case "price":
    case "stock":
    case "buy":
      if (intent.terms.length === 0) {
        if (!ctx.lastOffer) return { reply: copy.askProduct };
        return {
          calls: [{ name: "get_offer_details", arguments: { offer_id: ctx.lastOffer.offer_id } }],
        };
      }
      return { calls: [{ name: "search_offers", arguments: searchArgs(intent.terms) }] };
    case "search":
      if (intent.terms.length === 0) return { reply: copy.askProduct };
      return { calls: [{ name: "search_offers", arguments: searchArgs(intent.terms) }] };
  }
}

function searchArgs(terms: string[]): Record<string, unknown> {
  return { ...(terms.length ? { query: terms.join(" ") } : {}), limit: MAX_LISTED + 1 };
}

function continueDecision(
  intent: Intent,
  ctx: FallbackContext,
  batches: ToolBatch[],
  key: string,
): Decision {
  const copy = COPY[intent.lang];
  const last = batches.at(-1);
  if (!last) return { reply: copy.help };
  const first = last.calls[0]?.name;
  const english = englishTerms(intent.terms);

  if (first === "get_business_info") {
    return {
      reply: infoReply(intent.topic ?? "general", resultOf(last, "get_business_info")?.data, copy),
    };
  }

  if (first === "submit_inquiry") {
    const result = resultOf(last, "submit_inquiry");
    if (!asRecord(result?.data)) return { reply: copy.error };
    const args = last.calls[0]?.arguments ?? {};
    const hadContact = asRecord(args.contact) !== null;
    if (
      ctx.pending?.kind === "inquiry_sent" ||
      (ctx.pending === null && intent.kind === "contact")
    ) {
      return { reply: copy.contactSent };
    }
    return { reply: hadContact ? copy.inquirySent : `${copy.inquirySent} ${copy.addContact}` };
  }

  if (first === "create_order") {
    const data = asRecord(resultOf(last, "create_order")?.data);
    if (!data) return { reply: copy.orderError };
    const size = shopperSize(intent, ctx.userMessages);
    return { reply: data.status === "draft" ? orderSummary(data, copy, size) : copy.orderSent };
  }

  if (first === "search_offers" || first === "get_offer_details") {
    const offers = offersOf(last);
    const failed = last.results.every((r) => r.data === null);
    if (failed) return { reply: copy.error };

    if (offers.length === 0 && first === "search_offers") {
      const translated = english.primary.join(" ") !== intent.terms.join(" ");
      if (batches.length === 1 && translated) {
        return { calls: [{ name: "search_offers", arguments: searchArgs(english.primary) }] };
      }
      const split = translated ? english.all : intent.terms;
      const stage = translated ? 2 : 1;
      if (batches.length === stage && last.calls.length === 1 && split.length > 1) {
        return {
          calls: split.slice(0, 3).map((term) => ({
            name: "search_offers",
            arguments: searchArgs([term]),
          })),
        };
      }
    }

    if (intent.kind === "buy") {
      if (offers.length === 0) return { reply: `${copy.noMatch} ${handoffText(copy)}` };
      const size = shopperSize(intent, ctx.userMessages);
      const offer = pickOffer(offers, english.primary.length ? english.primary : intent.terms);
      if (!offer) {
        const titles = offers.slice(0, MAX_LISTED).map((o) => `- ${o.title}: ${priceOf(o, copy)}`);
        return { reply: [copy.which, ...titles].join("\n") };
      }
      if (offer.can_order !== true) {
        const why =
          offer.price_status !== "confirmed"
            ? copy.priceOnRequest.toLowerCase()
            : availabilityOf(offer, copy);
        return { reply: `${copy.notOrderable(offer.title, why)} ${handoffText(copy)}` };
      }
      const sizes = Array.isArray(offer.attributes?.sizes)
        ? offer.attributes.sizes.map(String)
        : [];
      if (sizes.length > 0 && (!size || !sizes.includes(size))) {
        return { reply: copy.sizeAsk(sizes.join(", ")) };
      }
      return {
        calls: [
          {
            name: "create_order",
            arguments: {
              idempotency_key: key,
              items: [{ offer_id: offer.offer_id, quantity: intent.quantity }],
              submit: false,
              ...(size ? { contact: noteArg(size) } : {}),
            },
          },
        ],
      };
    }

    const total = first === "search_offers" ? totalOf(last, offers.length) : offers.length;
    return { reply: offersReply(offers, total, intent, copy) };
  }

  return { reply: copy.error };
}

function totalOf(batch: ToolBatch, fallback: number): number {
  let total = 0;
  for (const result of batch.results) {
    const data = asRecord(result.data);
    if (data && typeof data.total === "number") total += data.total;
  }
  return Math.max(total, fallback);
}

export function decide(messages: LlmMessage[], key: string): Decision {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return { reply: COPY.en.help };

  const text = messageText(messages[lastUser]);
  const lang = conversationLang(
    messages.filter((m) => m.role === "user").map((m) => messageText(m)),
  );
  const intent = { ...parseIntent(text), lang };
  const ctx = readContext(messages.slice(0, lastUser));
  const batches = readBatches(messages.slice(lastUser + 1));
  if (batches.length === 0) return startDecision(intent, ctx, text, key);
  const withCurrent = { ...ctx, userMessages: [...ctx.userMessages, text] };
  return continueDecision(intent, withCurrent, batches, key);
}

export function createFallbackLlm(): LlmClient {
  return {
    mode: "native",
    model: "rule-based-fallback",
    async chat(request: LlmChatRequest): Promise<LlmChatResult> {
      const key = `fb-${randomUUID()}`;
      const decision = decide(request.messages, key);
      if ("reply" in decision) {
        return { content: decision.reply, toolCalls: [], finishReason: "stop" };
      }
      return {
        content: null,
        finishReason: "tool_calls",
        toolCalls: decision.calls.map((call) => ({
          id: `fb_${randomUUID().slice(0, 12)}`,
          name: call.name,
          arguments: call.arguments,
        })),
      };
    },
  };
}
