import { describe, expect, it } from "vitest";
import {
  UI_LABELS,
  chatReducer,
  detectUiLang,
  flushNdjson,
  initialChatState,
  isOrderDetailsValid,
  parseNdjsonChunk,
  safeChatImage,
  toOfferChips,
  type ChatAction,
  type ChatState,
  type StreamEvent,
} from "@/app/s/[slug]/chat-state";

const draft = {
  order_id: "o-1",
  status: "draft",
  items: [{ title: "Runner", quantity: 2, unitPrice: 50, currency: "USD", lineTotal: 100 }],
  total: 100,
  currency: "USD",
  total_label: "$100.00",
  next_step: "Confirm to send",
};

function run(actions: ChatAction[], from: ChatState = initialChatState): ChatState {
  return actions.reduce(chatReducer, from);
}

const ev = (event: StreamEvent): ChatAction => ({ type: "stream_event", event });

describe("parseNdjsonChunk", () => {
  it("parses whole lines", () => {
    const r = parseNdjsonChunk("", '{"type":"message","content":"hi"}\n{"type":"done"}\n');
    expect(r.events).toHaveLength(2);
    expect(r.rest).toBe("");
  });

  it("joins an object split across chunks", () => {
    const a = parseNdjsonChunk("", '{"type":"mess');
    expect(a.events).toEqual([]);
    const b = parseNdjsonChunk(a.rest, 'age","content":"hi"}\n');
    expect(b.events).toEqual([{ type: "message", content: "hi" }]);
  });

  it("keeps a trailing partial line until the next chunk", () => {
    const a = parseNdjsonChunk("", '{"type":"done"}\n{"type":"err');
    expect(a.events).toHaveLength(1);
    expect(a.rest).toBe('{"type":"err');
  });

  it("ignores blank lines", () => {
    const r = parseNdjsonChunk("", '\n  \n{"type":"done"}\n\n');
    expect(r.events).toHaveLength(1);
    expect(r.invalid).toBe(0);
  });

  it("counts invalid lines and keeps later events", () => {
    const r = parseNdjsonChunk("", 'oops\n{"x":1}\n{"type":"done"}\n');
    expect(r.invalid).toBe(2);
    expect(r.events).toEqual([{ type: "done" }]);
  });

  it("flushes a final line without newline", () => {
    expect(flushNdjson('{"type":"done"}').events).toHaveLength(1);
    expect(flushNdjson("  ").events).toEqual([]);
  });
});

describe("chatReducer", () => {
  it("adds the user message and starts sending", () => {
    const s = run([{ type: "user_sent", text: "hello" }]);
    expect(s.sending).toBe(true);
    expect(s.items[0]).toMatchObject({ kind: "message", role: "user", content: "hello" });
  });

  it("sets activity on tool calls", () => {
    const s = run([ev({ type: "tool_call", name: "search_offers" })]);
    expect(s.activity).toBe("Searching the catalog");
  });

  it("creates an order card from a draft result", () => {
    const s = run([ev({ type: "tool_result", name: "create_order", data: draft })]);
    expect(s.items[0]).toMatchObject({
      kind: "order",
      order: { orderId: "o-1", status: "draft", totalLabel: "$100.00" },
    });
  });

  it("marks the same order as sent on a submitted result", () => {
    const s = run([
      ev({ type: "tool_result", name: "create_order", data: draft }),
      ev({ type: "tool_result", name: "create_order", data: { ...draft, status: "submitted" } }),
    ]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ order: { status: "submitted" } });
  });

  it("appends an assistant message and clears activity", () => {
    const s = run([
      ev({ type: "tool_call", name: "search_offers" }),
      ev({ type: "message", content: "Here you go" }),
    ]);
    expect(s.activity).toBeNull();
    expect(s.items.at(-1)).toMatchObject({ role: "assistant", content: "Here you go" });
  });

  it("adds a note for a successful inquiry", () => {
    const s = run([
      ev({ type: "tool_result", name: "submit_inquiry", data: { inquiry_id: "i-1" } }),
    ]);
    expect(s.items[0]).toMatchObject({ kind: "note", text: "Inquiry sent to the store" });
  });

  it("sets a retryable error on error events and stops sending", () => {
    const s = run([{ type: "user_sent", text: "x" }, ev({ type: "error", message: "Nope" })]);
    expect(s.sending).toBe(false);
    expect(s.error).toEqual({ message: "Nope", retryable: true });
  });

  it("switches to unavailable", () => {
    const s = run([{ type: "user_sent", text: "x" }, { type: "unavailable" }]);
    expect(s.available).toBe(false);
    expect(s.sending).toBe(false);
  });

  it("loads history and availability", () => {
    const s = run([
      { type: "history_loaded", available: false, messages: [{ role: "user", content: "a" }] },
    ]);
    expect(s.available).toBe(false);
    expect(s.items).toHaveLength(1);
  });

  it("handles confirm success and failure", () => {
    const base = run([ev({ type: "tool_result", name: "create_order", data: draft })]);
    const started = chatReducer(base, { type: "confirm_started", orderId: "o-1" });
    expect(started.items[0]).toMatchObject({ order: { confirming: true } });
    const failed = chatReducer(started, {
      type: "confirm_failed",
      orderId: "o-1",
      message: "Already closed",
    });
    expect(failed.items[0]).toMatchObject({
      order: { confirming: false, error: "Already closed" },
    });
    const ok = chatReducer(failed, {
      type: "confirm_succeeded",
      order: { ...draft, status: "submitted" },
    });
    expect(ok.items[0]).toMatchObject({
      order: { status: "submitted", confirming: false, error: null },
    });
  });
});

describe("offer cards", () => {
  it("shows search results after the assistant message", () => {
    const s = run([
      { type: "user_sent", text: "shoes" },
      {
        type: "stream_event",
        event: {
          type: "tool_result",
          name: "search_offers",
          data: { offers: [{ offer_id: "a", title: "Runner", price_label: "10 KZT" }] },
        },
      },
      { type: "stream_event", event: { type: "message", content: "Found one" } },
      { type: "stream_event", event: { type: "done" } },
    ]);
    expect(s.items.map((i) => i.kind)).toEqual(["message", "message", "offers"]);
    expect(s.pendingOffers).toEqual([]);
  });
});

describe("offer card data", () => {
  it("maps image, availability and orderability from a search result", () => {
    const chips = toOfferChips({
      offers: [
        {
          offer_id: "a",
          title: "Runner",
          price_label: "10 KZT",
          availability: "in_stock",
          availability_label: "In stock",
          image_url: "/demo/a.svg",
          can_order: true,
        },
        { offer_id: "b", title: "Boot", image_url: "http://insecure.example/x.png" },
        { offer_id: "c", title: "Sandal", image_url: "javascript:alert(1)", can_order: false },
      ],
    });
    expect(chips[0]).toMatchObject({ imageUrl: "/demo/a.svg", canOrder: true });
    expect(chips[1]).toMatchObject({
      imageUrl: null,
      canOrder: false,
      priceLabel: "Price on request",
    });
    expect(chips[2]?.imageUrl).toBeNull();
    expect(safeChatImage("https://cdn.example/x.png")).toBe("https://cdn.example/x.png");
    expect(safeChatImage("//evil.example/x.png")).toBeNull();
  });
});

describe("interface language", () => {
  it("detects Cyrillic text", () => {
    expect(detectUiLang("Хочу заказать")).toBe("ru");
    expect(detectUiLang("order it")).toBe("en");
    expect(UI_LABELS.ru.confirm).toBe("Подтвердить заказ");
  });

  it("detects Kazakh text", () => {
    expect(detectUiLang("Тапсырыс бергім келеді")).toBe("kk");
    expect(detectUiLang("Бағасы қанша?")).toBe("kk");
    expect(detectUiLang("Иә")).toBe("kk");
    expect(detectUiLang("Привет")).toBe("ru");
    expect(UI_LABELS.kk.confirm).toBe("Тапсырысты растау");
  });

  it("labels activity from the last user message", () => {
    const s = run([
      { type: "user_sent", text: "Есть кроссовки?" },
      ev({ type: "tool_call", name: "search_offers" }),
    ]);
    expect(s.activity).toBe("Ищу в каталоге");
  });
});

describe("history polling", () => {
  const loaded = run([
    { type: "history_loaded", available: true, messages: [{ role: "user", content: "Hi" }] },
  ]);

  it("appends a new store answer once", () => {
    const messages = [
      { role: "user" as const, content: "Hi" },
      { role: "assistant" as const, content: "Answer from the store: Yes" },
    ];
    const once = run([{ type: "history_polled", messages }], loaded);
    const twice = run([{ type: "history_polled", messages }], once);
    expect(twice.items.map((i) => (i.kind === "message" ? i.content : i.kind))).toEqual([
      "Hi",
      "Answer from the store: Yes",
    ]);
  });

  it("ignores other assistant messages and skips while sending", () => {
    const other = run(
      [{ type: "history_polled", messages: [{ role: "assistant", content: "Sure" }] }],
      loaded,
    );
    expect(other.items).toHaveLength(1);
    const busy = run([{ type: "user_sent", text: "Q" }], loaded);
    const polled = run(
      [
        {
          type: "history_polled",
          messages: [{ role: "assistant", content: "Ответ магазина: Да" }],
        },
      ],
      busy,
    );
    expect(polled.items).toHaveLength(2);
  });

  it("keeps order cards in place", () => {
    const withCard = run([ev({ type: "tool_result", name: "create_order", data: draft })], loaded);
    const next = run(
      [
        {
          type: "history_polled",
          messages: [{ role: "assistant", content: "Ответ магазина: Да" }],
        },
      ],
      withCard,
    );
    expect(next.items.map((i) => i.kind)).toEqual(["message", "order", "message"]);
  });
});

describe("isOrderDetailsValid", () => {
  const ok = {
    name: "Aidar",
    phone: "+7 701 000 11 22",
    fulfillment: "pickup" as "pickup" | "delivery" | null,
    address: "",
    city: "",
  };

  it("accepts pickup without an address or city", () => {
    expect(isOrderDetailsValid(ok)).toBe(true);
  });

  it("requires an address and a city for delivery only", () => {
    const delivery = { ...ok, fulfillment: "delivery" as const };
    expect(isOrderDetailsValid(delivery)).toBe(false);
    expect(isOrderDetailsValid({ ...delivery, address: "   ", city: "Almaty" })).toBe(false);
    expect(isOrderDetailsValid({ ...delivery, address: "Abay 10" })).toBe(false);
    expect(isOrderDetailsValid({ ...delivery, address: "Abay 10", city: "  " })).toBe(false);
    expect(isOrderDetailsValid({ ...delivery, address: "Abay 10", city: "Almaty" })).toBe(true);
  });

  it("requires a name, a phone with at least seven digits and a fulfillment choice", () => {
    expect(isOrderDetailsValid({ ...ok, name: "  " })).toBe(false);
    expect(isOrderDetailsValid({ ...ok, phone: "" })).toBe(false);
    expect(isOrderDetailsValid({ ...ok, phone: "12 34 56" })).toBe(false);
    expect(isOrderDetailsValid({ ...ok, phone: "123-45-67" })).toBe(true);
    expect(isOrderDetailsValid({ ...ok, fulfillment: null })).toBe(false);
  });
});

describe("order card details", () => {
  it("fills the card from the order view and keeps it empty for unknown values", () => {
    const filled = run([
      ev({
        type: "tool_result",
        name: "create_order",
        data: {
          ...draft,
          contact: { name: "Aidar", phone: "+7 701 000 11 22" },
          fulfillment: "delivery",
          delivery_address: "Abay 10",
        },
      }),
    ]);
    const card = filled.items.find((i) => i.kind === "order");
    expect(card?.kind === "order" && card.order).toMatchObject({
      name: "Aidar",
      phone: "+7 701 000 11 22",
      fulfillment: "delivery",
      address: "Abay 10",
    });

    const bare = run([ev({ type: "tool_result", name: "create_order", data: draft })]);
    const empty = bare.items.find((i) => i.kind === "order");
    expect(empty?.kind === "order" && empty.order).toMatchObject({
      name: "",
      phone: "",
      fulfillment: null,
      address: "",
    });
  });
});

describe("order card with several items", () => {
  const twoLines = {
    ...draft,
    items: [
      {
        offerId: "a",
        size: "42",
        title: "Runner",
        quantity: 1,
        unitPrice: 50,
        currency: "USD",
        lineTotal: 50,
      },
      { offerId: "b", title: "Cap", quantity: 2, unitPrice: 10, currency: "USD", lineTotal: 20 },
    ],
    total: 70,
    total_label: "$70.00",
    city: "Almaty",
  };

  it("replaces the lines and the total when the order is updated", () => {
    const s = run([
      ev({ type: "tool_result", name: "create_order", data: draft }),
      { type: "confirm_started", orderId: "o-1" },
      { type: "order_updated", order: twoLines },
    ]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({
      order: { confirming: false, total: 70, totalLabel: "$70.00", city: "Almaty" },
    });
    const card = s.items[0];
    expect(card?.kind === "order" && card.order.items.map((i) => i.title)).toEqual([
      "Runner",
      "Cap",
    ]);
  });

  it("keeps a single card when the assistant adds an item to the same order", () => {
    const s = run([
      ev({ type: "tool_result", name: "create_order", data: draft }),
      ev({ type: "tool_result", name: "create_order", data: twoLines }),
    ]);
    expect(s.items.filter((i) => i.kind === "order")).toHaveLength(1);
  });
});
