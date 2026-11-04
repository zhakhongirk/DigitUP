/**
 * Rule-based stand-in for the language model, used when no LLM is configured.
 * It is stateless: every decision is derived from the conversation history it
 * is given, and it acts only through the Customer Agent's own tools, so
 * messages, inquiries and orders follow the same path as with a real model.
 */
import { randomUUID } from "node:crypto";
import type { LlmChatRequest, LlmChatResult, LlmClient, LlmMessage } from "@/server/llm";
import {
  BARE_SIZE_IN_TEXT_RE,
  BARE_SIZE_RE,
  extractBudget,
  SIZE_RE,
} from "@/server/services/intent/budget";
import { englishTerms, searchTerms } from "@/server/services/intent/lexicon";
import { detectTextLang } from "@/shared/text-lang";

export { englishTerms, extractBudget, searchTerms };

export type Lang = "en" | "ru" | "kk";
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
  /** Upper price limit the shopper named, in the store's currency. */
  maxPrice: number | null;
  /** The message with contact details and quantity removed, as handed to the intent layer. */
  searchText: string;
  contact: ShopperContact;
}

const EMAIL_RE = /[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+/;
const PHONE_RE = /\+?\d[\d\s().-]{5,}\d/;
const NAME_RE =
  /(?<![\p{L}])(?:[Mm]y name is|[Ii]'m|I am|[Мм]еня зовут|[Мм]о[её] имя|[Ээ]то|[Мм]енің атым|[Аа]тым)\s+(\p{Lu}[\p{L}'-]*(?:\s+\p{Lu}[\p{L}'-]*)?)/u;
const QUANTITY_RES = [
  /(\d{1,2})\s*(?:pcs|pieces|piece|pairs?|units?|шт|штук|штуки|пар|пары|дана|жұп)(?![\p{L}])/iu,
  /(?:buy|order|take|add|also|plus|купить|заказать|беру|возьму|добав\p{L}*|ещё|еще)\s+(\d{1,2})(?=\s)/iu,
  /(?:^|\s)x\s?(\d{1,2})(?=$|[\s,.!?])/i,
];
const PICKUP_RE =
  /(?<![\p{L}])(?:pick\s?-?up|collect|self[- ]?pickup|самовывоз\p{L}*|заберу|забрать|өзім\s+алып\s+кет\p{L}*|өзім\s+ал\p{L}*|алып\s+кет\p{L}*)/iu;
const DELIVERY_RE =
  /(?<![\p{L}])(?:deliver\p{L}*|ship\p{L}*|courier|доставк\p{L}*|доставьте|курьер\p{L}*|привез\p{L}*|жеткіз\p{L}*)/iu;
const ADDRESS_RE =
  /(?:(?:deliver\p{L}*|ship\p{L}*)\s+(?:to|at)|(?:доставк\p{L}*|доставьте)\s+(?:на|по|в)|(?<![\p{L}])(?:address|адрес|мекенжай\p{L}*))\s*[:-]?\s*(\S.{3,})$/iu;
const CITY_RE = /(?:^|[\s,;])(?:city|город|қала\p{L}*)\s*[:-]?\s*(\p{L}[\p{L} .-]{1,59})$/iu;
const ADD_SOURCE =
  "(?<![\\p{L}])(?:add|adding|also|another|plus|добав\\p{L}*|ещё|еще|плюс|также|заодно|тоже|қос\\p{L}*|тағы|сондай-ақ)(?![\\p{L}])";
const ADD_RE = new RegExp(ADD_SOURCE, "iu");
const ADD_CARD_RE = /^(?:Add to order|Добавить в заказ|Тапсырысқа қосу):\s*(.+)$/isu;
const ADDED_REPLY_RE =
  /× \d+\. (?:Your order now has \d+ items|В заказе теперь позиций: \d+|Тапсырыста қазір \d+ тауар)\.$/u;
const MAX_LINE_QUANTITY = 20;
const ADD_MORE_RE = /^\W*(?:add another item|добавить ещё товар|тағы тауар қосу)\W*$/iu;
const REMOVE_SOURCE =
  "(?<![\\p{L}])(?:remove|delete|drop|убери\\p{L}*|убрать|удали\\p{L}*|удалить|без|алып\\s+таста\\p{L}*|жой\\p{L}*|өшір\\p{L}*)(?![\\p{L}])";
const REMOVE_RE = new RegExp(REMOVE_SOURCE, "iu");
const END = "(?=$|[\\s,.!?])";

function stripWords(text: string, source: string): string {
  return text.replace(new RegExp(source, "giu"), " ").replace(/\s+/g, " ").trim();
}

const YES_RE = new RegExp(
  `^\\W*(yes|yeah|yep|yup|ok|okay|sure|confirm|confirmed|go ahead|please do|да|ага|угу|ок|окей|давай|давайте|конечно|подтверждаю|подтвердить|оформляй|оформляйте|оформите|иә|иа|жарайды|жақсы|келісемін|растаймын|болады)${END}`,
  "i",
);
const NO_RE = new RegExp(
  `^\\W*(no|nope|nah|cancel|not now|нет|не надо|не нужно|отмена|отменить|не сейчас|потом|жоқ|керек емес|болмайды|бас тарту|қазір емес)${END}`,
  "i",
);
const GREETING_RE = new RegExp(
  `^\\W*(hi|hello|hey|hola|good (morning|afternoon|evening)|привет|здравствуй|здравствуйте|добрый|салам|сәлем|сәлеметсіз бе|сәлеметсіздер ме|салем|ассалаумағалейкум|амансыз ба|қайырлы (таң|күн|кеш))${END}`,
  "i",
);
const HELP_RE =
  /\b(help|what can you|how does this work)\b|помощь|помоги|что (ты )?умеешь|что можешь|көмек|не істей аласыз|не істей аласың/i;
const HUMAN_RE =
  /\b(owner|human|real person|talk to a person|manager|operator|staff|someone|seller|representative|call me|contact me)\b|владел|человек|менеджер|оператор|продав|сотрудник|живой|перезвон|свяжитесь|связаться со|иесімен|иесі|менеджер|оператор|сатушы|қызметкер|тірі адам|қоңырау шал/i;
const BUY_RE =
  /\b(buy|purchase|order|i'll take|ill take|checkout)\b|куп(ить|лю|и)(?![\p{L}])|заказат|оформ|беру|возьму|сатып\s+ал|тапсырыс\s+бер|тапсырыс\s+жаса|алғым\s+кел|аламын|алайын|рәсімде/iu;
const TRACK_RE =
  /\b(status|track|tracking)\b|статус|отследить|где мой|тапсырысым\s+қайда|тапсырыс\s+күйі|күйі\s+қандай|бақыла/i;
const PRICE_RE =
  /\b(how much|price|prices|cost|costs|cheap|cheaper|expensive)\b|сколько|цен[аыуе]|почём|стоим|стоит|стоят|қанша|баға|құны|тұрады|қымбат|арзан/i;
const STOCK_RE =
  /\b(in stock|available|availability|sizes?|left)\b|в налич|наличие|остал|размер|есть ли в|бар\s*ма|қалды\s+ма|қолда\s+бар|қоймада|өлшем/i;

const TOPIC_RES: [InfoTopic, RegExp, RegExp][] = [
  [
    "hours",
    /\b(opening hours|working hours|business hours|opening times|are you open|open now|open today|when do you (open|close)|when are you open)\b|часы работы|режим работы|график работы|работаете|жұмыс\s+(уақыты|кестесі|режимі)|қашан\s+(ашылады|жабылады|ашық)|ашық\s+па|жұмыс\s+істейсіз/i,
    /\b(hours|opening|closing|schedule|working time)\b|режим|график|открыт/i,
  ],
  ["delivery", /\b(deliver\w*|shipping|ship)\b|доставк|привез|курьер|жеткіз|тасымал/i, /(?!)/],
  [
    "payment",
    /\b(pay|payment|payments|pay by card|by card|card payment|cash|kaspi|installment)\b|оплат|налич(н|ным)|рассрочк|төлем|төлеу|төлей|қолма-қол|бөліп\s+төле/i,
    /карт/i,
  ],
  [
    "returns",
    /\b(return policy|refunds?)\b|возврат|қайтару|қайтарым/i,
    /\b(return|returns|exchange|warranty)\b|обмен|гарант|айырбас|кепілдік/i,
  ],
  [
    "address",
    /\b(address|where are you|directions)\b|адрес|где наход|как добраться|где вы|мекенжай|қайда\s+орналас|қайдасыз|қалай\s+жетем/i,
    /\b(located|location)\b/i,
  ],
  [
    "contact",
    /\b(phone number|contact details|whatsapp|telegram|instagram|email address)\b|контакты|номер телефона|байланыс\s+(нөмір|деректер)|телефон\s+нөмір/i,
    /\b(phone|call|contact|contacts|email)\b|телефон|позвон|номер|контакт|написать|нөмір|байланыс/i,
  ],
  [
    "general",
    /\b(about (the )?(store|shop)|who are you)\b|о магазин|о вас|кто вы|дүкен\s+туралы|сіз\s+кімсіз/i,
    /(?!)/,
  ],
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
  return detectTextLang(text);
}

function detectLang(text: string): Lang {
  return messageLang(text) ?? "en";
}

/**
 * Language of the shopper's side of the chat. Messages without letters (phone
 * numbers, digits, emoji) say nothing about language and are skipped. The
 * dominant language wins; on a tie the latest letter-bearing message decides.
 */
const LANGS: Lang[] = ["en", "ru", "kk"];

export function conversationLang(texts: string[]): Lang {
  const counts: Record<Lang, number> = { en: 0, ru: 0, kk: 0 };
  let latest: Lang | null = null;
  for (const text of texts) {
    const lang = messageLang(text);
    if (!lang) continue;
    counts[lang] += 1;
    latest = lang;
  }
  const top = Math.max(counts.en, counts.ru, counts.kk);
  const leaders = LANGS.filter((lang) => counts[lang] === top);
  if (leaders.length === 1) return leaders[0] ?? "en";
  return latest !== null && leaders.includes(latest) ? latest : (leaders[0] ?? "en");
}

function wordCount(text: string): number {
  return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean).length;
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

/** True when the shopper's message is a plain yes to the order they were shown. */
export function isExplicitConfirmation(message: string): boolean {
  return parseIntent(message).kind === "yes";
}

export function parseIntent(input: string): Intent {
  const text = input.trim();
  const lang = detectLang(text);
  const { maxPrice, rest: withoutBudget } = extractBudget(text);
  const { contact, rest: withoutContact } = extractContact(withoutBudget);

  let rest = withoutContact;
  let searchText = extractContact(text).rest;
  const sizeMatch = SIZE_RE.exec(rest);
  let size = sizeMatch ? (sizeMatch[1] ?? sizeMatch[2] ?? "").replace(",", ".") : null;
  if (sizeMatch) rest = rest.replace(sizeMatch[0], " ");
  let quantity = 1;
  for (const re of QUANTITY_RES) {
    const match = re.exec(rest);
    if (match) {
      quantity = Math.min(Math.max(Number(match[1]), 1), MAX_LINE_QUANTITY);
      rest = rest.replace(match[0], " ");
      searchText = searchText.replace(match[0], " ");
      break;
    }
  }

  if (size === null && searchTerms(rest).length > 0) {
    const bare = BARE_SIZE_IN_TEXT_RE.exec(rest);
    if (bare) {
      size = bare[0];
      rest = rest.replace(bare[0], " ");
    }
  }

  const terms = searchTerms(rest);
  const base = {
    lang,
    terms,
    topic: null,
    quantity,
    size,
    maxPrice,
    searchText: searchText.replace(/\s+/g, " ").trim(),
    contact,
  } satisfies Omit<Intent, "kind">;
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
    loosened: (steps: string) => `There was no exact match, so I loosened: ${steps}.`,
    steps: { size: "size", color: "color", budget: "budget", category: "category" },
    found: "Here is what I found:",
    more: (n: number) => `...and ${n} more. Tell me a bit more to narrow it down.`,
    priceOnRequest: "Price on request",
    withinBudget: (amount: string) => `Within ${amount}:`,
    nothingWithinBudget: (amount: string) => `No offer with a confirmed price is within ${amount}.`,
    onRequestLead:
      "The price of these is on request, so I cannot say whether they fit your budget:",
    availability: {
      in_stock: "in stock",
      out_of_stock: "out of stock",
      unknown: "availability to be confirmed",
    },
    sizes: (list: string) => `sizes: ${list}`,
    sizeYes: (size: string) => `size ${size} is listed`,
    sizeNo: (size: string) => `size ${size} is not listed`,
    sizeOut: (size: string) => `size ${size} is out of stock`,
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
    sizeWord: "size",
    maxQty: "You can order up to 20 of one item.",
    added: (title: string, size: string | null, qty: number, n: number) =>
      `Added ${title}${size ? ` (${size})` : ""} × ${qty}. Your order now has ${n} items.`,
    askCity: "What city is the delivery to?",
    askAdd: "Which product would you like to add? Tell me the name.",
    removeWhich: (titles: string) => `Which item should I remove? ${titles}`,
    sizeAsk: (list: string, out?: string) =>
      `${out ? `Size ${out} is out of stock. ` : ""}Which size? Available: ${list}.`,
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
    loosened: (steps: string) => `Точного совпадения не было, поэтому я ослабил: ${steps}.`,
    steps: { size: "размер", color: "цвет", budget: "бюджет", category: "категория" },
    found: "Вот что нашлось:",
    more: (n: number) => `...и ещё ${n}. Уточните запрос, чтобы сузить выбор.`,
    priceOnRequest: "Цена по запросу",
    withinBudget: (amount: string) => `В пределах ${amount}:`,
    nothingWithinBudget: (amount: string) => `С подтверждённой ценой до ${amount} ничего нет.`,
    onRequestLead:
      "Цена этих товаров по запросу, поэтому не могу сказать, укладываются ли они в бюджет:",
    availability: {
      in_stock: "в наличии",
      out_of_stock: "нет в наличии",
      unknown: "наличие уточняется",
    },
    sizes: (list: string) => `размеры: ${list}`,
    sizeYes: (size: string) => `размер ${size} есть в списке`,
    sizeNo: (size: string) => `размера ${size} нет в списке`,
    sizeOut: (size: string) => `размера ${size} нет в наличии`,
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
    sizeWord: "размер",
    maxQty: "Можно заказать не больше 20 шт. одного товара.",
    added: (title: string, size: string | null, qty: number, n: number) =>
      `Добавила ${title}${size ? ` (${size})` : ""} × ${qty}. В заказе теперь позиций: ${n}.`,
    askCity: "В какой город доставить?",
    askAdd: "Какой товар добавить? Напишите название.",
    removeWhich: (titles: string) => `Какой товар убрать? ${titles}`,
    sizeAsk: (list: string, out?: string) =>
      `${out ? `Размера ${out} нет в наличии. ` : ""}Какой размер? Есть: ${list}.`,
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
  kk: {
    help:
      "Мен тауарларды таба аламын, бағасы мен барын айта аламын, жеткізу, төлем және қайтару туралы жауап беремін " +
      "немесе сұрағыңызды дүкен иесіне жіберемін. Сізді не қызықтырады?",
    greeting: "Сәлеметсіз бе! ",
    noMatch: "Каталогтан бұны таба алмадым.",
    loosened: (steps: string) => `Нақты сәйкестік болмады, сондықтан жеңілдеттім: ${steps}.`,
    steps: { size: "өлшем", color: "түс", budget: "бюджет", category: "санат" },
    found: "Мынау табылды:",
    more: (n: number) => `...және тағы ${n}. Таңдауды тарылту үшін сұрауды нақтылаңыз.`,
    priceOnRequest: "Бағасы сұраныс бойынша",
    withinBudget: (amount: string) => `${amount} дейін:`,
    nothingWithinBudget: (amount: string) => `Расталған бағасы ${amount} дейін тауар жоқ.`,
    onRequestLead:
      "Бұл тауарлардың бағасы сұраныс бойынша, сондықтан бюджетке сыятынын айта алмаймын:",
    availability: {
      in_stock: "бар",
      out_of_stock: "қалмаған",
      unknown: "бары нақтылануда",
    },
    sizes: (list: string) => `өлшемдері: ${list}`,
    sizeYes: (size: string) => `${size} өлшемі тізімде бар`,
    sizeNo: (size: string) => `${size} өлшемі тізімде жоқ`,
    sizeOut: (size: string) => `${size} өлшемі қолда жоқ`,
    handoff:
      "Мұны дүкен иесіне жіберейін бе? Иә деп жауап беріңіз немесе онымен байланысу үшін телефон не пошта жіберіңіз.",
    inquirySent: "Дайын, сұрағыңыз дүкен иесіне жіберілді. Ол сізге жауап береді.",
    addContact: "Сізбен тікелей байланысу үшін келесі хабарламада телефон немесе пошта жіберіңіз.",
    contactSent: "Рахмет, байланыс деректеріңізді дүкен иесіне жібердім.",
    declined: "Жарайды, жібермеймін. Тағы немен көмектесейін?",
    topicLabel: {
      hours: "жұмыс уақыты",
      delivery: "жеткізу шарттары",
      payment: "төлем тәсілдері",
      returns: "қайтару шарттары",
      address: "мекенжай",
      contact: "байланыс деректері",
      general: "дүкен туралы ақпарат",
    },
    topicMissing: (label: string) => `Дүкен әлі растаған жоқ: ${label}.`,
    topicHeading: (label: string) => label.charAt(0).toUpperCase() + label.slice(1),
    contactsLine: "Дүкенмен мына жерден байланысуға болады",
    which: "Нақты қай тауарға тапсырыс берейін? Атауын жазыңыз.",
    notOrderable: (title: string, why: string) =>
      `${title} қазір онлайн тапсырыс беру мүмкін емес (${why}).`,
    orderDraft: (lines: string, total: string) =>
      `Сіздің тапсырысыңыз: ${lines}. Барлығы ${total}. Ол әлі рәсімделген жоқ.`,
    orderPrompt:
      "Рәсімдеу үшін төмендегі «Тапсырысты растау» түймесін басыңыз немесе атыңызды, телефоныңызды және өзі алып кету не жеткізу ыңғайлы екенін (мекенжайымен) жазыңыз. Бас тарту үшін жоқ деп жауап беріңіз.",
    sizeWord: "өлшемі",
    maxQty: "Бір тауардан 20 данадан артық тапсырыс беруге болмайды.",
    added: (title: string, size: string | null, qty: number, n: number) =>
      `${title}${size ? ` (${size})` : ""} × ${qty} қосылды. Тапсырыста қазір ${n} тауар.`,
    askCity: "Қай қалаға жеткізу керек?",
    askAdd: "Қай тауарды қосайын? Атауын жазыңыз.",
    removeWhich: (titles: string) => `Қай тауарды алып тастайын? ${titles}`,
    sizeAsk: (list: string, out?: string) =>
      `${out ? `${out} өлшемі қолда жоқ. ` : ""}Қандай өлшем? Бары: ${list}.`,
    askName: "Атыңыз кім?",
    askPhone: "Дүкен сізге қай телефон нөміріне қоңырау шала алады?",
    askFulfillment: "Өзіңіз алып кетесіз бе, әлде жеткізу керек пе?",
    askAddress: "Жеткізу мекенжайы қандай?",
    orderSent: "Тапсырыс дүкенге жіберілді. Иесі растау үшін сізбен байланысады.",
    orderCancelled: "Жарайды, тапсырыс рәсімделмеді. Ештеңе жіберілген жоқ.",
    orderError:
      "Тапсырысты рәсімдеу мүмкін болмады. Ол бұрын жіберілген болуы мүмкін; тапсырыс карточкасын тексеріңіз немесе дүкенмен байланысыңыз.",
    orderWaiting:
      "Тапсырысты рәсімдеу үшін деректеріңізді жазыңыз немесе төмендегі «Тапсырысты растау» түймесін басыңыз.",
    error: "Кешіріңіз, қазір болмады. Қайтадан көріңіз немесе дүкенмен тікелей байланысыңыз.",
    askOwner: "Әрине.",
    askProduct: "Қай тауар туралы айтасыз? Атауын немесе нені іздеп жатқаныңызды жазыңыз.",
  },
} as const;

type Copy = (typeof COPY)[Lang];

const SIZE_ASK_RE = /(?:Which size\? Available|Какой размер\? Есть|Қандай өлшем\? Бары): (.+)\.$/u;

type AskKind = "name" | "phone" | "fulfillment" | "address" | "city";
type PromptKey =
  | "handoff"
  | "addContact"
  | "orderPrompt"
  | "askName"
  | "askPhone"
  | "askFulfillment"
  | "askAddress"
  | "askCity"
  | "askAdd";

const ASKS: [AskKind, PromptKey][] = [
  ["name", "askName"],
  ["phone", "askPhone"],
  ["fulfillment", "askFulfillment"],
  ["address", "askAddress"],
  ["city", "askCity"],
];

function endsWithPrompt(text: string, key: PromptKey): boolean {
  return LANGS.some((lang) => text.endsWith(COPY[lang][key]));
}

function isCopy(text: string, key: "orderSent" | "orderCancelled"): boolean {
  return LANGS.some((lang) => text === COPY[lang][key]);
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
  city?: string;
}

function parseOrderDetails(text: string, asking: AskKind | null, inOrder: boolean): OrderDetails {
  const { contact, rest } = extractContact(text);
  const details: OrderDetails = { ...contact };
  let clean = rest.replace(/\s+/g, " ").trim();
  if (inOrder || asking) {
    const cityMatch = CITY_RE.exec(clean);
    if (cityMatch?.[1]) {
      details.city = cityMatch[1].trim().slice(0, 100);
      clean = clean
        .replace(cityMatch[0], " ")
        .replace(/\s+/g, " ")
        .replace(/[\s,;]+$/, "")
        .trim();
    }
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
    asking === "city" &&
    !details.city &&
    !details.fulfillment &&
    clean &&
    !/[\d?]/.test(clean) &&
    wordCount(clean) <= 4 &&
    !YES_RE.test(clean) &&
    !NO_RE.test(clean)
  ) {
    details.city = clean
      .replace(/[.,!;]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
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
  unavailable_sizes?: string[];
  matched?: { size?: boolean | null };
}

export interface DraftItem {
  offer_id: string;
  title: string;
  quantity: number;
  size?: string;
}

/** The shopper's order that was drafted in this conversation and not yet sent or cancelled. */
export interface Draft {
  key: string;
  items: DraftItem[];
}

export type Pending =
  | { kind: "handoff"; question: string }
  | { kind: "add" }
  | {
      kind: "size";
      offerId: string;
      quantity: number;
      sizes: string[];
      title: string;
      draft: Draft | null;
    }
  | { kind: "inquiry_sent" }
  | {
      kind: "order";
      key: string;
      items: { offer_id: string; quantity: number; size?: string }[];
      asking: AskKind | null;
      details: OrderDetails;
    };

export interface FallbackContext {
  pending: Pending | null;
  draft: Draft | null;
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
    const list = Array.isArray(data.offers)
      ? [...data.offers, ...(Array.isArray(data.on_request) ? data.on_request : [])]
      : [data];
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
      else if (isCopy(text, "orderSent")) inOrder = false;
      else if (isCopy(text, "orderCancelled")) inOrder = false;
    } else if (message.role === "user") {
      details = mergeDetails(
        details,
        parseOrderDetails(messageText(message), askingOf(previous), inOrder),
      );
    }
  }
  return details;
}

function draftItems(value: unknown): DraftItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: DraftItem[] = [];
  for (const raw of value) {
    const item = asRecord(raw);
    const id = item?.offerId ?? item?.offer_id;
    if (!item || typeof id !== "string" || typeof item.quantity !== "number") return null;
    items.push({
      offer_id: id,
      title: typeof item.title === "string" ? item.title : "",
      quantity: item.quantity,
      ...(typeof item.size === "string" && item.size ? { size: item.size } : {}),
    });
  }
  return items.length > 0 ? items : null;
}

function openDraft(history: LlmMessage[]): Draft | null {
  let draft: Draft | null = null;
  let key: string | null = null;
  for (const message of history) {
    if (message.role === "assistant" && message.toolCalls?.length) {
      const call = message.toolCalls.find((c) => c.name === "create_order");
      if (typeof call?.arguments.idempotency_key === "string") key = call.arguments.idempotency_key;
    } else if (message.role === "tool" && message.name === "create_order") {
      const data = asRecord(parseJson(message.content));
      if (data && typeof data.status === "string" && key) {
        const items = draftItems(data.items);
        draft = data.status === "draft" && items ? { key, items } : null;
      }
    } else if (message.role === "assistant") {
      const text = messageText(message);
      if (isCopy(text, "orderCancelled")) draft = null;
    }
  }
  return draft;
}

function addedBefore(history: LlmMessage[], askIndex: number): boolean {
  let index = askIndex - 1;
  while (index >= 0 && history[index]?.role !== "user") index--;
  if (index < 0) return false;
  if (ADD_RE.test(messageText(history[index]))) return true;
  for (let i = index - 1; i >= 0; i--) {
    const message = history[i];
    if (message?.role === "user") return false;
    if (message?.role === "assistant" && !message.toolCalls?.length && messageText(message)) {
      return endsWithPrompt(messageText(message), "askAdd");
    }
  }
  return false;
}

const SHOWS_OFFERS = new Set(["find_offers", "search_offers", "get_offer_details"]);

export function readContext(history: LlmMessage[]): FallbackContext {
  const draft = openDraft(history);
  const batches = readBatches(history);
  let lastOffer: ShownOffer | null = null;
  for (const batch of batches) {
    if (!batch.calls.some((c) => SHOWS_OFFERS.has(c.name))) {
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
      .find((m) => ADD_RE.test(m) || parseIntent(m).kind === "buy");
    if (offer) {
      pending = {
        kind: "size",
        offerId: offer.offer_id,
        quantity: buy ? parseIntent(buy).quantity : 1,
        sizes: listed.split(", "),
        title: offer.title,
        draft: addedBefore(history, lastIndex) ? draft : null,
      };
    }
  } else if (endsWithPrompt(lastText, "handoff")) {
    const before = history.slice(0, lastIndex).filter((m) => m.role === "user");
    pending = { kind: "handoff", question: messageText(before.at(-1)) };
  } else if (draft && endsWithPrompt(lastText, "askAdd")) {
    pending = { kind: "add" };
  } else if (endsWithPrompt(lastText, "addContact")) {
    pending = { kind: "inquiry_sent" };
  } else if (
    endsWithPrompt(lastText, "orderPrompt") ||
    ADDED_REPLY_RE.test(lastText) ||
    askingOf(lastText) !== null
  ) {
    const create = batches.filter((b) => b.calls.some((c) => c.name === "create_order")).at(-1);
    const args = create?.calls.find((c) => c.name === "create_order")?.arguments;
    const key = typeof args?.idempotency_key === "string" ? args.idempotency_key : null;
    if (key && Array.isArray(args?.items)) {
      pending = {
        kind: "order",
        key,
        items: draft
          ? draft.items.map(({ offer_id, quantity, size }) => ({
              offer_id,
              quantity,
              ...(size ? { size } : {}),
            }))
          : (args.items as { offer_id: string; quantity: number; size?: string }[]),
        asking: askingOf(lastText),
        details: collectDetails(history),
      };
    }
  }
  return { pending, draft, lastOffer, userMessages };
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
  const out = offer.unavailable_sizes ?? [];
  if (!Array.isArray(sizes) || (sizes.length === 0 && out.length === 0)) return null;
  const list = sizes.map(String);
  if (intent.size) {
    if (offer.availability === "in_stock" && out.includes(intent.size)) {
      return copy.sizeOut(intent.size);
    }
    const fits =
      typeof offer.matched?.size === "boolean" ? offer.matched.size : list.includes(intent.size);
    return fits ? copy.sizeYes(intent.size) : copy.sizeNo(intent.size);
  }
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

function formatAmount(amount: number): string {
  return new Intl.NumberFormat("en-US").format(amount).replace(/,/g, " ");
}

function budgetReply(offers: ShownOffer[], maxPrice: number, shopper: Intent, copy: Copy): string {
  const intent: Intent = { ...shopper, kind: "search" };
  const amount = formatAmount(maxPrice);
  const priced = offers.filter((o) => o.price_status === "confirmed");
  const unpriced = offers.filter((o) => o.price_status !== "confirmed");
  const parts: string[] = [];
  if (priced.length > 0) {
    parts.push(
      [
        copy.withinBudget(amount),
        ...priced.slice(0, MAX_LISTED).map((o) => offerLine(o, intent, copy)),
      ].join("\n"),
    );
    if (priced.length > MAX_LISTED) parts.push(copy.more(priced.length - MAX_LISTED));
  } else {
    parts.push(copy.nothingWithinBudget(amount));
  }
  if (unpriced.length > 0) {
    parts.push(
      [
        copy.onRequestLead,
        ...unpriced.slice(0, MAX_LISTED).map((o) => offerLine(o, intent, copy)),
      ].join("\n"),
      handoffText(copy),
    );
  }
  return parts.join("\n");
}

function offersReply(offers: ShownOffer[], total: number, intent: Intent, copy: Copy): string {
  if (offers.length === 0) return `${copy.noMatch} ${handoffText(copy)}`;
  if (intent.maxPrice !== null) return budgetReply(offers, intent.maxPrice, intent, copy);
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

function orderSummary(data: Record<string, unknown>, copy: Copy): string {
  const items = Array.isArray(data.items) ? data.items : [];
  const lines = items
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => {
      const size =
        typeof item.size === "string" && item.size ? ` (${copy.sizeWord} ${item.size})` : "";
      return `${String(item.title)}${size} x ${String(item.quantity)}`;
    })
    .join(", ");
  const total = typeof data.total_label === "string" ? data.total_label : copy.priceOnRequest;
  return `${copy.orderDraft(lines, total)} ${copy.orderPrompt}`;
}

function resultOf(batch: ToolBatch, name: string): { data: unknown } | null {
  return batch.results.find((r) => r.name === name) ?? null;
}

function noteArg(size: string | null): Record<string, unknown> {
  return size ? { note: `Size: ${size}` } : {};
}

function noteOf(items: { title: string; size?: string }[]): Record<string, unknown> {
  const sized = items.filter((item) => item.size);
  if (sized.length === 0) return {};
  const first = sized[0];
  const note =
    items.length === 1 && first
      ? `Size: ${first.size}`
      : `Sizes: ${sized.map((item) => `${item.title} ${item.size}`).join("; ")}`;
  return { contact: { note } };
}

function lineArg(offer: ShownOffer, quantity: number, size: string | null) {
  return { offer_id: offer.offer_id, quantity, ...(size ? { size } : {}) };
}

function removeDecision(intent: Intent, ctx: FallbackContext, text: string): Decision | null {
  const draft = ctx.draft;
  if (!draft || !REMOVE_RE.test(text)) return null;
  const copy = COPY[intent.lang];
  const terms = searchTerms(stripWords(text, REMOVE_SOURCE));
  const wanted = [...terms, ...englishTerms(terms).all];
  const hits = draft.items.filter((item) =>
    wanted.some((word) => item.title.toLowerCase().includes(word)),
  );
  const hitIds = new Set(hits.map((item) => item.offer_id));
  if (terms.length === 0 || hitIds.size !== 1) {
    const titles = [...new Set(draft.items.map((item) => item.title))].join(", ");
    return { reply: copy.removeWhich(titles) };
  }
  const remaining = draft.items.filter((item) => !hitIds.has(item.offer_id));
  if (remaining.length === 0) return { reply: copy.orderCancelled };
  return {
    calls: [
      {
        name: "create_order",
        arguments: {
          idempotency_key: draft.key,
          items: remaining.map(({ offer_id, quantity, size }) => ({
            offer_id,
            quantity,
            ...(size ? { size } : {}),
          })),
          submit: false,
          ...noteOf(remaining),
        },
      },
    ],
  };
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
          : details.fulfillment === "delivery" && !details.city
            ? copy.askCity
            : null;
  if (ask) return { reply: ask };
  const contact = {
    ...contactArg(details),
    ...(pending.items.some((item) => item.size)
      ? {}
      : noteArg(shopperSize(intent, ctx.userMessages))),
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
          ...(details.fulfillment === "delivery"
            ? { delivery_address: details.address, city: details.city }
            : {}),
        },
      },
    ],
  };
}

function atCap(draft: Draft | null, line: { offer_id: string; quantity: number; size?: string }) {
  const existing = draft?.items.find(
    (item) => item.offer_id === line.offer_id && (item.size ?? "") === (line.size ?? ""),
  );
  return existing !== undefined && existing.quantity + line.quantity > MAX_LINE_QUANTITY;
}

function addedReply(
  data: Record<string, unknown>,
  call: { arguments: Record<string, unknown> },
  copy: Copy,
): string | null {
  const [added] = Array.isArray(call.arguments.items) ? call.arguments.items : [];
  const line = asRecord(added);
  const items = draftItems(data.items);
  if (!line || !items) return null;
  const size = typeof line.size === "string" && line.size ? line.size : "";
  const item = items.find(
    (entry) => entry.offer_id === line.offer_id && (entry.size ?? "") === size,
  );
  return item ? copy.added(item.title, size || null, item.quantity, items.length) : null;
}

function startDecision(
  intent: Intent,
  ctx: FallbackContext,
  text: string,
  key: string,
  adding: boolean,
): Decision {
  const copy = COPY[intent.lang];
  const { pending } = ctx;
  if (pending?.kind === "size") {
    const size = intent.size ?? BARE_SIZE_RE.exec(text)?.[1]?.replace(",", ".") ?? null;
    if (size && pending.sizes.includes(size)) {
      const line = { offer_id: pending.offerId, quantity: pending.quantity, size };
      if (atCap(pending.draft, line)) return { reply: copy.maxQty };
      const all = [...(pending.draft?.items ?? []), { ...line, title: pending.title }];
      return {
        calls: [
          {
            name: "create_order",
            arguments: {
              idempotency_key: pending.draft?.key ?? key,
              items: [line],
              ...(pending.draft ? { merge: true } : {}),
              submit: false,
              ...noteOf(all),
            },
          },
        ],
      };
    }
    if (size) return { reply: copy.sizeAsk(pending.sizes.join(", ")) };
    if (intent.kind === "no") {
      return { reply: pending.draft ? copy.orderWaiting : copy.orderCancelled };
    }
  }
  const removal = removeDecision(intent, ctx, text);
  if (removal) return removal;
  if (adding && ctx.draft) {
    if (intent.terms.length === 0) return { reply: copy.askAdd };
    return { calls: [{ name: "find_offers", arguments: searchArgs(intent) }] };
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
      if (pending?.kind === "add") return { reply: copy.orderWaiting };
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
      return { calls: [{ name: "find_offers", arguments: searchArgs(intent) }] };
    case "search":
      if (intent.terms.length === 0 && !hasSearchFilters(intent)) {
        return { reply: copy.askProduct };
      }
      return { calls: [{ name: "find_offers", arguments: searchArgs(intent) }] };
  }
}

function searchArgs(intent: Intent): Record<string, unknown> {
  const text = intent.kind === "buy" ? intent.terms.join(" ") : intent.searchText;
  return { intent: text.trim() || intent.terms.join(" "), lang: intent.lang };
}

function hasSearchFilters(intent: Intent): boolean {
  return intent.maxPrice !== null || (intent.size !== null && intent.kind === "search");
}

function continueDecision(
  intent: Intent,
  ctx: FallbackContext,
  batches: ToolBatch[],
  key: string,
  adding: boolean,
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
    if (data.status !== "draft") return { reply: copy.orderSent };
    const call = last.calls[0];
    const added = call?.arguments.merge === true ? addedReply(data, call, copy) : null;
    return { reply: added ?? orderSummary(data, copy) };
  }

  if (first === "find_offers" || first === "search_offers" || first === "get_offer_details") {
    const offers = offersOf(last);
    const failed = last.results.every((r) => r.data === null);
    if (failed) return { reply: copy.error };

    if (intent.kind === "buy") {
      if (offers.length === 0) return { reply: `${copy.noMatch} ${handoffText(copy)}` };
      const size = adding ? intent.size : shopperSize(intent, ctx.userMessages);
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
      const out = size && offer.unavailable_sizes?.includes(size) ? size : undefined;
      if (sizes.length > 0 && (!size || !sizes.includes(size))) {
        return { reply: copy.sizeAsk(sizes.join(", "), out) };
      }
      const line = lineArg(offer, intent.quantity, size);
      const draft = adding ? ctx.draft : null;
      if (atCap(draft, line)) return { reply: copy.maxQty };
      const all = [...(draft?.items ?? []), { ...line, title: offer.title }];
      return {
        calls: [
          {
            name: "create_order",
            arguments: {
              idempotency_key: draft?.key ?? key,
              items: [line],
              ...(draft ? { merge: true } : {}),
              submit: false,
              ...noteOf(all),
            },
          },
        ],
      };
    }

    const total = first === "get_offer_details" ? offers.length : totalOf(last, offers.length);
    const note = loosenedNote(last, copy);
    const reply = offersReply(offers, total, intent, copy);
    return {
      reply: note
        ? `${note}
${reply}`
        : reply,
    };
  }

  return { reply: copy.error };
}

function loosenedNote(batch: ToolBatch, copy: Copy): string | null {
  const names: string[] = [];
  for (const result of batch.results) {
    const relaxed = asRecord(result.data)?.relaxed;
    if (!Array.isArray(relaxed)) continue;
    for (const step of relaxed) {
      const name = asRecord(step)?.step;
      if (typeof name === "string" && name in copy.steps) {
        names.push(copy.steps[name as keyof Copy["steps"]]);
      }
    }
  }
  return names.length > 0 ? copy.loosened(names.join(", ")) : null;
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
  const ctx = readContext(messages.slice(0, lastUser));
  const plain = parseIntent(text);
  const adding =
    ctx.draft !== null &&
    (ADD_RE.test(text) ||
      (ctx.pending?.kind === "add" && ["search", "buy", "price", "stock"].includes(plain.kind)));
  const card = ADD_CARD_RE.exec(text);
  const intent: Intent = card?.[1]
    ? { ...parseIntent(card[1]), lang, quantity: 1, size: null, maxPrice: null, kind: "buy" }
    : adding
      ? (() => {
          const stripped = ADD_MORE_RE.test(text) ? "" : stripWords(text, ADD_SOURCE);
          const parsed = parseIntent(stripped);
          return {
            ...parsed,
            lang,
            quantity: plain.quantity > 1 ? plain.quantity : parsed.quantity,
            kind: parsed.terms.length > 0 ? "buy" : "search",
          };
        })()
      : { ...plain, lang };
  const batches = readBatches(messages.slice(lastUser + 1));
  if (batches.length === 0) return startDecision(intent, ctx, text, key, adding);
  const withCurrent = { ...ctx, userMessages: [...ctx.userMessages, text] };
  return continueDecision(intent, withCurrent, batches, key, adding);
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
