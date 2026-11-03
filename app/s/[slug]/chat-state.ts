export const MAX_MESSAGE_CHARS = 2000;

export const UNAVAILABLE_NOTICE =
  "The store assistant is not available yet. You can browse the catalog and contact the store directly.";

export type UiLang = "en" | "ru";

export function detectUiLang(text: string): UiLang {
  return /[а-яё]/i.test(text) ? "ru" : "en";
}

export const TOOL_LABELS: Record<UiLang, Record<string, string>> = {
  en: {
    search_offers: "Searching the catalog",
    get_offer_details: "Looking at the offer",
    check_availability: "Checking availability",
    compare_offers: "Comparing offers",
    get_business_info: "Checking store info",
    create_order: "Preparing your order",
    submit_inquiry: "Sending your inquiry",
  },
  ru: {
    search_offers: "Ищу в каталоге",
    get_offer_details: "Смотрю товар",
    check_availability: "Проверяю наличие",
    compare_offers: "Сравниваю товары",
    get_business_info: "Смотрю данные магазина",
    create_order: "Готовлю заказ",
    submit_inquiry: "Отправляю вопрос",
  },
};

export function toolLabel(name: string, lang: UiLang = "en"): string {
  return TOOL_LABELS[lang][name] ?? (lang === "ru" ? "Работаю над этим" : "Working on it");
}

export const UI_LABELS = {
  en: {
    confirm: "Confirm order",
    sending: "Sending...",
    track: "Track order",
    typing: "Typing",
    placeholder: "Message",
    inquirySent: "Inquiry sent to the store",
  },
  ru: {
    confirm: "Подтвердить заказ",
    sending: "Отправляю…",
    track: "Отследить заказ",
    typing: "Печатает",
    placeholder: "Сообщение",
    inquirySent: "Вопрос отправлен в магазин",
  },
} as const;

export const SUGGESTIONS: { en: string; ru: string }[] = [
  { en: "What's in stock?", ru: "Что есть в наличии?" },
  { en: "Delivery and payment", ru: "Доставка и оплата" },
  { en: "Prices", ru: "Цены" },
];

export type OrderLine = {
  offerId?: string;
  size?: string;
  title: string;
  quantity: number;
  unitPrice: number | string;
  currency: string;
  lineTotal: number | string;
};

export type OrderView = {
  order_id: string;
  status: string;
  items: OrderLine[];
  total: number | string;
  currency: string;
  total_label?: string;
  next_step?: string;
  contact?: { name?: string; phone?: string };
  fulfillment?: string | null;
  delivery_address?: string | null;
  city?: string | null;
};

export type StreamEvent =
  | { type: "tool_call"; id?: string; name: string; arguments?: unknown }
  | { type: "tool_result"; id?: string; name: string; isError?: boolean; data?: unknown }
  | { type: "message"; content: string }
  | { type: "done"; conversationId?: string; stoppedBy?: string }
  | { type: "error"; message: string };

export type ParseResult = { events: StreamEvent[]; rest: string; invalid: number };

const EVENT_TYPES = new Set(["tool_call", "tool_result", "message", "done", "error"]);

function isStreamEvent(value: unknown): value is StreamEvent {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && EVENT_TYPES.has(type);
}

/**
 * Feeds a chunk into the line buffer. Complete lines are parsed; the trailing
 * partial line is returned as `rest` and must be passed back with the next chunk.
 */
export function parseNdjsonChunk(buffer: string, chunk: string): ParseResult {
  const lines = (buffer + chunk).split("\n");
  const rest = lines.pop() ?? "";
  const events: StreamEvent[] = [];
  let invalid = 0;
  for (const line of lines) {
    const text = line.trim();
    if (text === "") continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (isStreamEvent(parsed)) events.push(parsed);
      else invalid += 1;
    } catch {
      invalid += 1;
    }
  }
  return { events, rest, invalid };
}

/** Parses whatever is left in the buffer once the stream has ended. */
export function flushNdjson(buffer: string): ParseResult {
  return parseNdjsonChunk("", buffer.trim() === "" ? "" : `${buffer}\n`);
}

export type OrderCard = {
  orderId: string;
  status: string;
  items: OrderLine[];
  total: number | string;
  currency: string;
  totalLabel: string | null;
  nextStep: string | null;
  name: string;
  phone: string;
  fulfillment: "pickup" | "delivery" | null;
  address: string;
  city: string;
  confirming: boolean;
  error: string | null;
};

export type OfferChip = {
  id: string;
  title: string;
  priceLabel: string;
  availability: string;
  availabilityLabel: string;
  imageUrl: string | null;
  canOrder: boolean;
};

export const MAX_OFFER_CARDS = 3;

export function safeChatImage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.trim();
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  return /^https:\/\/[^\s]+$/i.test(url) ? url : null;
}

export function toOfferChips(data: unknown): OfferChip[] {
  const r = asRecord(data);
  if (!r) return [];
  const list = Array.isArray(r.offers) ? r.offers : [r];
  const chips: OfferChip[] = [];
  for (const entry of list) {
    const o = asRecord(entry);
    if (!o || typeof o.offer_id !== "string" || typeof o.title !== "string") continue;
    chips.push({
      id: o.offer_id,
      title: o.title,
      priceLabel: typeof o.price_label === "string" ? o.price_label : "Price on request",
      availability: typeof o.availability === "string" ? o.availability : "unknown",
      availabilityLabel: typeof o.availability_label === "string" ? o.availability_label : "",
      imageUrl: safeChatImage(o.image_url),
      canOrder: o.can_order === true,
    });
  }
  return chips;
}

export type ChatItem =
  | { kind: "message"; id: number; role: "user" | "assistant"; content: string }
  | { kind: "order"; id: number; order: OrderCard }
  | { kind: "offers"; id: number; offers: OfferChip[] }
  | { kind: "note"; id: number; text: string };

export type ChatError = { message: string; retryable: boolean };

export type ChatState = {
  loaded: boolean;
  available: boolean;
  items: ChatItem[];
  activity: string | null;
  sending: boolean;
  error: ChatError | null;
  pendingOffers: OfferChip[];
  nextId: number;
};

export const initialChatState: ChatState = {
  loaded: false,
  available: true,
  items: [],
  activity: null,
  sending: false,
  error: null,
  pendingOffers: [],
  nextId: 1,
};

export type ChatAction =
  | {
      type: "history_loaded";
      available: boolean;
      messages: { role: "user" | "assistant"; content: string }[];
    }
  | { type: "history_polled"; messages: { role: "user" | "assistant"; content: string }[] }
  | { type: "history_failed" }
  | { type: "user_sent"; text: string }
  | { type: "retry_started" }
  | { type: "stream_event"; event: StreamEvent }
  | { type: "stream_failed"; message: string }
  | { type: "unavailable" }
  | { type: "confirm_started"; orderId: string }
  | { type: "confirm_succeeded"; order: OrderView }
  | { type: "order_updated"; order: OrderView }
  | { type: "confirm_failed"; orderId: string; message: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function toOrderView(data: unknown): OrderView | null {
  const r = asRecord(data);
  if (!r || typeof r.order_id !== "string" || typeof r.status !== "string") return null;
  if (!Array.isArray(r.items)) return null;
  const contact = asRecord(r.contact);
  return {
    order_id: r.order_id,
    status: r.status,
    items: r.items as OrderLine[],
    total: (r.total as number | string | undefined) ?? 0,
    currency: typeof r.currency === "string" ? r.currency : "",
    ...(typeof r.total_label === "string" ? { total_label: r.total_label } : {}),
    ...(typeof r.next_step === "string" ? { next_step: r.next_step } : {}),
    contact: {
      ...(typeof contact?.name === "string" ? { name: contact.name } : {}),
      ...(typeof contact?.phone === "string" ? { phone: contact.phone } : {}),
    },
    fulfillment: typeof r.fulfillment === "string" ? r.fulfillment : null,
    delivery_address: typeof r.delivery_address === "string" ? r.delivery_address : null,
    city: typeof r.city === "string" ? r.city : null,
  };
}

export function isOrderDetailsValid(details: {
  name: string;
  phone: string;
  fulfillment: "pickup" | "delivery" | null;
  address: string;
  city: string;
}): boolean {
  return (
    details.name.trim().length > 0 &&
    details.phone.replace(/\D/g, "").length >= 7 &&
    details.fulfillment !== null &&
    (details.fulfillment === "pickup" ||
      (details.address.trim().length > 0 && details.city.trim().length > 0))
  );
}

function cardFrom(view: OrderView, previous?: OrderCard): OrderCard {
  return {
    orderId: view.order_id,
    status: view.status,
    items: view.items,
    total: view.total,
    currency: view.currency,
    totalLabel: view.total_label ?? null,
    nextStep: view.next_step ?? null,
    name: view.contact?.name ?? "",
    phone: view.contact?.phone ?? "",
    fulfillment:
      view.fulfillment === "pickup" || view.fulfillment === "delivery" ? view.fulfillment : null,
    address: view.delivery_address ?? "",
    city: view.city ?? "",
    confirming: false,
    error: previous?.status === view.status ? previous.error : null,
  };
}

function upsertOrder(state: ChatState, view: OrderView): ChatState {
  const index = state.items.findIndex(
    (item) => item.kind === "order" && item.order.orderId === view.order_id,
  );
  if (index >= 0) {
    const existing = state.items[index];
    if (existing?.kind !== "order") return state;
    const items = state.items.slice();
    items[index] = { ...existing, order: cardFrom(view, existing.order) };
    return { ...state, items };
  }
  const item: ChatItem = { kind: "order", id: state.nextId, order: cardFrom(view) };
  return { ...state, items: [...state.items, item], nextId: state.nextId + 1 };
}

function updateOrder(
  state: ChatState,
  orderId: string,
  change: (card: OrderCard) => OrderCard,
): ChatState {
  return {
    ...state,
    items: state.items.map((item) =>
      item.kind === "order" && item.order.orderId === orderId
        ? { ...item, order: change(item.order) }
        : item,
    ),
  };
}

function appendItem(state: ChatState, build: (id: number) => ChatItem): ChatState {
  return { ...state, items: [...state.items, build(state.nextId)], nextId: state.nextId + 1 };
}

function flushOffers(state: ChatState): ChatState {
  if (state.pendingOffers.length === 0) return state;
  const offers = state.pendingOffers.slice(0, MAX_OFFER_CARDS);
  return appendItem({ ...state, pendingOffers: [] }, (id) => ({ kind: "offers", id, offers }));
}

export function lastUserLang(items: ChatItem[], fallback: UiLang = "en"): UiLang {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === "message" && item.role === "user") return detectUiLang(item.content);
  }
  return fallback;
}

const STORE_ANSWER =
  /^(Answer from the store|Ответ магазина|Order cancelled by the store|Заказ отменён магазином): /;

/** Appends store answers that arrived while the chat was open and are not shown yet. */
export function mergeHistory(
  state: ChatState,
  messages: { role: "user" | "assistant"; content: string }[],
): ChatState {
  const shown = new Map<string, number>();
  for (const item of state.items) {
    if (item.kind !== "message" || item.role !== "assistant") continue;
    shown.set(item.content, (shown.get(item.content) ?? 0) + 1);
  }
  let next = state;
  for (const m of messages) {
    if (m.role !== "assistant" || !STORE_ANSWER.test(m.content)) continue;
    const left = shown.get(m.content) ?? 0;
    if (left > 0) {
      shown.set(m.content, left - 1);
      continue;
    }
    next = appendItem(next, (id) => ({ kind: "message", id, role: m.role, content: m.content }));
  }
  return next;
}

function applyStreamEvent(state: ChatState, event: StreamEvent): ChatState {
  const lang = lastUserLang(state.items);
  switch (event.type) {
    case "tool_call":
      return { ...state, activity: toolLabel(event.name, lang) };
    case "tool_result": {
      const cleared = { ...state, activity: null };
      if (event.isError) return cleared;
      if (event.name === "create_order") {
        const view = toOrderView(event.data);
        return view ? upsertOrder(cleared, view) : cleared;
      }
      if (event.name === "submit_inquiry") {
        return appendItem(cleared, (id) => ({
          kind: "note",
          id,
          text: UI_LABELS[lang].inquirySent,
        }));
      }
      if (event.name === "search_offers" || event.name === "get_offer_details") {
        const seen = new Set(cleared.pendingOffers.map((o) => o.id));
        const fresh = toOfferChips(event.data).filter((o) => !seen.has(o.id));
        return { ...cleared, pendingOffers: [...cleared.pendingOffers, ...fresh] };
      }
      return cleared;
    }
    case "message":
      return flushOffers(
        appendItem({ ...state, activity: null }, (id) => ({
          kind: "message",
          id,
          role: "assistant",
          content: event.content,
        })),
      );
    case "done":
      return flushOffers({ ...state, sending: false, activity: null });
    case "error":
      return {
        ...state,
        sending: false,
        activity: null,
        pendingOffers: [],
        error: { message: event.message, retryable: true },
      };
  }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "history_loaded": {
      let next: ChatState = { ...state, loaded: true, available: action.available, items: [] };
      for (const m of action.messages) {
        next = appendItem(next, (id) => ({
          kind: "message",
          id,
          role: m.role,
          content: m.content,
        }));
      }
      return next;
    }
    case "history_polled":
      return state.sending ? state : mergeHistory(state, action.messages);
    case "history_failed":
      return { ...state, loaded: true };
    case "user_sent":
      return {
        ...appendItem(state, (id) => ({
          kind: "message",
          id,
          role: "user",
          content: action.text,
        })),
        sending: true,
        activity: null,
        error: null,
      };
    case "retry_started":
      return { ...state, sending: true, activity: null, error: null };
    case "stream_event":
      return applyStreamEvent(state, action.event);
    case "stream_failed":
      return {
        ...state,
        sending: false,
        activity: null,
        error: { message: action.message, retryable: true },
      };
    case "unavailable":
      return { ...state, available: false, sending: false, activity: null, error: null };
    case "confirm_started":
      return updateOrder(state, action.orderId, (c) => ({ ...c, confirming: true, error: null }));
    case "confirm_succeeded":
      return updateOrder(state, action.order.order_id, (c) => ({
        ...cardFrom(action.order, c),
        error: null,
      }));
    case "order_updated":
      return updateOrder(state, action.order.order_id, (c) => cardFrom(action.order, c));
    case "confirm_failed":
      return updateOrder(state, action.orderId, (c) => ({
        ...c,
        confirming: false,
        error: action.message,
      }));
  }
}
