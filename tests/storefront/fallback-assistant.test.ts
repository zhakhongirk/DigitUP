import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmMessage } from "@/server/llm";
import { handleChatMessage, newChatSession } from "@/server/storefront/chat";
import {
  decide,
  englishTerms,
  parseIntent,
  readContext,
  searchTerms,
  type Decision,
} from "@/server/storefront/fallback-assistant";
import type { BusinessModelInput } from "@/shared/business-model";
import { createTestTenant } from "../helpers/db";
import { testServices } from "../helpers/mcp";

describe("parseIntent", () => {
  it.each([
    ["hello", "greeting"],
    ["Привет!", "greeting"],
    ["what can you do?", "help"],
    ["do you have running shoes?", "search"],
    ["покажи кроссовки", "search"],
    ["how much is the Runner", "price"],
    ["сколько стоит куртка", "price"],
    ["is the Runner in stock?", "stock"],
    ["есть ли размер 42", "stock"],
    ["I want to buy the Runner", "buy"],
    ["хочу купить кроссовки", "buy"],
    ["can I talk to the owner", "human"],
    ["позовите менеджера", "human"],
    ["yes", "yes"],
    ["да, оформляйте", "yes"],
    ["no thanks", "no"],
    ["+7 700 111 22 33", "contact"],
    ["me@example.com", "contact"],
  ])("classifies %j as %s", (text, kind) => {
    expect(parseIntent(text).kind).toBe(kind);
  });

  it.each([
    ["when do you open?", "hours"],
    ["do you deliver to Almaty", "delivery"],
    ["доставка есть?", "delivery"],
    ["can I pay by card", "payment"],
    ["оплата наличными", "payment"],
    ["what is your return policy", "returns"],
    ["what is your address", "address"],
    ["your phone number please", "contact"],
  ])("detects the info topic of %j", (text, topic) => {
    const intent = parseIntent(text);
    expect(intent.kind).toBe("info");
    expect(intent.topic).toBe(topic);
  });

  it("extracts size, quantity and contact", () => {
    const intent = parseIntent("buy 2 pairs of Runner size 42, call +7 700 111 22 33");
    expect(intent.kind).toBe("buy");
    expect(intent.quantity).toBe(2);
    expect(intent.size).toBe("42");
    expect(intent.contact.phone).toBe("+7 700 111 22 33");
    expect(intent.terms).toEqual(["runner"]);
  });

  it("detects the language", () => {
    expect(parseIntent("сколько стоит").lang).toBe("ru");
    expect(parseIntent("how much").lang).toBe("en");
  });
});

describe("sizes", () => {
  it.each([
    ["size 9.5", "9.5"],
    ["EU 42", "42"],
    ["размер 43", "43"],
    ["есть кроссовки 42 размера?", "42"],
    ["I need size: 43", "43"],
  ])("reads the size of %j", (text, size) => {
    expect(parseIntent(text).size).toBe(size);
  });
});

describe("russian search", () => {
  it("translates catalog nouns and colors", () => {
    expect(englishTerms(["кроссов", "красн"])).toEqual({
      primary: ["sneaker", "red"],
      all: ["sneaker", "shoe", "red"],
    });
    expect(englishTerms(searchTerms("детская стрижка")).primary).toEqual(["kids", "haircut"]);
    expect(englishTerms(["сервис"]).primary).toEqual(["сервис"]);
  });

  it("retries in English when the Russian query finds nothing", () => {
    const first = [
      user("покажи кроссовки"),
      ...toolTurn("search_offers", {}, { total: 0, offers: [] }),
    ];
    const [retry] = calls(decide(first, "k"));
    expect(retry).toEqual({ name: "search_offers", arguments: { query: "sneaker", limit: 6 } });
    const second = [
      ...first,
      ...toolTurn("search_offers", { query: "sneaker" }, { total: 1, offers: [runner] }),
    ];
    expect(reply(decide(second, "k"))).toBe("Вот что нашлось:\n- Runner: 100 KZT, в наличии");
  });

  it("falls back to single English synonyms", () => {
    const empty = toolTurn("search_offers", {}, { total: 0, offers: [] });
    const history = [user("кроссовки"), ...empty, ...empty];
    const split = calls(decide(history, "k"));
    expect(split.map((c) => c.arguments.query)).toEqual(["sneaker", "shoe"]);
  });
});

describe("searchTerms", () => {
  it("drops filler words and stems plurals", () => {
    expect(searchTerms("Do you have red sneakers?")).toEqual(["red", "sneaker"]);
    expect(searchTerms("покажи красные кроссовки")).toEqual(["красн", "кроссов"]);
  });
});

function user(content: string): LlmMessage {
  return { role: "user", content };
}
function assistant(content: string): LlmMessage {
  return { role: "assistant", content };
}
function toolTurn(name: string, args: Record<string, unknown>, data: unknown): LlmMessage[] {
  return [
    { role: "assistant", content: null, toolCalls: [{ id: "c1", name, arguments: args }] },
    { role: "tool", toolCallId: "c1", name, content: JSON.stringify(data) },
  ];
}

const runner = {
  offer_id: "00000000-0000-4000-8000-000000000001",
  title: "Runner",
  price: 100,
  price_status: "confirmed",
  price_label: "100 KZT",
  availability: "in_stock",
  can_order: true,
  attributes: { sizes: ["41", "42"] },
};
const quote = {
  offer_id: "00000000-0000-4000-8000-000000000002",
  title: "Custom boot",
  price: null,
  price_status: "on_request",
  price_label: "Price on request",
  availability: "unknown",
  can_order: false,
};

function reply(decision: Decision): string {
  if (!("reply" in decision)) throw new Error("expected a reply");
  return decision.reply;
}

function calls(decision: Decision) {
  if (!("calls" in decision)) throw new Error("expected tool calls");
  return decision.calls;
}

describe("decide", () => {
  it("greets without calling tools", () => {
    expect(reply(decide([user("hi")], "k"))).toContain("Hi!");
  });

  it("searches the catalog for product questions", () => {
    const [call] = calls(decide([user("do you have runner shoes?")], "k"));
    expect(call).toEqual({
      name: "search_offers",
      arguments: { query: "runner shoe", limit: 6 },
    });
  });

  it("lists prices and never invents a missing one", () => {
    const messages = [
      user("how much are the boots"),
      ...toolTurn("search_offers", {}, { total: 2, offers: [runner, quote] }),
    ];
    const text = reply(decide(messages, "k"));
    expect(text).toContain("- Runner: 100 KZT");
    expect(text).toContain("- Custom boot: Price on request");
    expect(text).toContain("pass this to the store owner");
  });

  it("answers availability and size from the tool data", () => {
    const messages = [
      user("is the Runner in stock in size 43"),
      ...toolTurn("search_offers", {}, { total: 1, offers: [runner] }),
    ];
    const text = reply(decide(messages, "k"));
    expect(text).toContain("in stock");
    expect(text).toContain("size 43 is not listed");
  });

  it("replies in Russian to a Russian question", () => {
    const messages = [
      user("сколько стоит Runner"),
      ...toolTurn("search_offers", {}, { total: 1, offers: [runner] }),
    ];
    expect(reply(decide(messages, "k"))).toContain("Вот что нашлось");
  });

  it("retries a multi-word search word by word, then offers the owner", () => {
    const first = [
      user("blue velvet sandals"),
      ...toolTurn("search_offers", {}, { total: 0, offers: [] }),
    ];
    const retry = calls(decide(first, "k"));
    expect(retry.map((c) => c.arguments.query)).toEqual(["blue", "velvet", "sandal"]);

    const second = [...first, ...toolTurn("search_offers", {}, { total: 0, offers: [] })];
    expect(reply(decide(second, "k"))).toContain("could not find");
  });

  it("answers store questions from policies and flags unconfirmed ones", () => {
    const info = {
      name: "Shoe Shop",
      description: "",
      contacts: { phone: "+77001112233" },
      policies: { delivery: "Free over 50 000 KZT", working_hours: "To be confirmed" },
      categories: [],
    };
    const delivery = [user("do you deliver?"), ...toolTurn("get_business_info", {}, info)];
    expect(reply(decide(delivery, "k"))).toContain("Free over 50 000 KZT");
    const hours = [user("what are your opening hours"), ...toolTurn("get_business_info", {}, info)];
    expect(reply(decide(hours, "k"))).toContain("has not confirmed working hours");
    const phone = [user("your phone number"), ...toolTurn("get_business_info", {}, info)];
    expect(reply(decide(phone, "k"))).toContain("+77001112233");
  });

  it.each([
    "Сколько стоит доставка?",
    "how much is delivery",
    "сколько стоит возврат",
    "какая цена доставки",
  ])("treats %j as a store question, not a catalog search", (text) => {
    expect(parseIntent(text).kind).toBe("info");
    const [call] = calls(decide([user(text)], "k"));
    expect(call?.name).toBe("get_business_info");
  });

  it.each([
    "price of the card holder",
    "open toe sandals",
    "number of sizes",
    "shoes for a person with wide feet",
  ])("keeps product words in %j out of store topics", (text) => {
    const intent = parseIntent(text);
    expect(["info", "human"]).not.toContain(intent.kind);
    expect(intent.topic).toBeNull();
  });

  it.each([
    ["opening hours", "hours"],
    ["working hours", "hours"],
    ["часы работы", "hours"],
    ["shipping", "delivery"],
    ["return policy", "returns"],
    ["возврат", "returns"],
    ["address", "address"],
    ["адрес", "address"],
    ["payment methods", "payment"],
    ["способы оплаты", "payment"],
  ])("detects %j as a store question", (text, topic) => {
    expect(parseIntent(text)).toMatchObject({ kind: "info", topic });
  });

  it.each(["talk to a person", "real person please", "manager", "владелец", "человек"])(
    "hands off %j to the owner",
    (text) => {
      expect(parseIntent(text).kind).toBe("human");
    },
  );

  it("asks which product when no product words are left", () => {
    for (const text of ["how much?", "сколько стоит?", "show me"]) {
      expect(reply(decide([user(text)], "k"))).toMatch(/Which product|О каком товаре/);
    }
  });

  it("does not repeat the label already in the policy text", () => {
    const info = {
      name: "S",
      contacts: {},
      policies: {
        working_hours: "Opening hours: every day 10:00-21:00.",
        delivery: "Доставка: бесплатно",
        returns: "Within 14 days",
      },
      categories: [],
    };
    const ask = (q: string) =>
      reply(decide([user(q), ...toolTurn("get_business_info", {}, info)], "k"));
    expect(ask("What are your opening hours?")).toBe("Working hours: every day 10:00-21:00.");
    expect(ask("доставка есть?")).toBe("Условия доставки: бесплатно");
    expect(ask("return policy")).toBe("Return policy: Within 14 days");
  });

  it("creates a draft order for a buy request", () => {
    const search = [
      user("I want to buy 2 Runner"),
      ...toolTurn("search_offers", {}, { total: 1, offers: [{ ...runner, attributes: {} }] }),
    ];
    const [call] = calls(decide(search, "key-1234567"));
    expect(call).toEqual({
      name: "create_order",
      arguments: {
        idempotency_key: "key-1234567",
        items: [{ offer_id: runner.offer_id, quantity: 2 }],
        submit: false,
      },
    });

    const draft = [
      ...search,
      ...toolTurn(
        "create_order",
        {},
        {
          order_id: "o1",
          status: "draft",
          items: [{ title: "Runner", quantity: 2 }],
          total_label: "200 KZT",
        },
      ),
    ];
    const text = reply(decide(draft, "x"));
    expect(text).toContain("Runner x 2");
    expect(text).toContain("200 KZT");
    expect(text).toContain("Confirm order");
  });

  describe("size step", () => {
    const buyEn = [
      user("I'd like to order 2 Runner"),
      ...toolTurn("search_offers", {}, { total: 1, offers: [runner] }),
    ];

    it("asks for the size before drafting", () => {
      expect(reply(decide(buyEn, "k"))).toBe("Which size? Available: 41, 42.");
      const ru = [
        user("Хочу заказать Runner"),
        ...toolTurn("search_offers", {}, { total: 1, offers: [runner] }),
      ];
      expect(reply(decide(ru, "k"))).toBe("Какой размер? Есть: 41, 42.");
    });

    it("drafts the order from a bare size answer", () => {
      const asked = [...buyEn, assistant("Which size? Available: 41, 42.")];
      expect(readContext(asked).pending).toMatchObject({ kind: "size", quantity: 2 });
      const [call] = calls(decide([...asked, user("42")], "key-1234567"));
      expect(call).toEqual({
        name: "create_order",
        arguments: {
          idempotency_key: "key-1234567",
          items: [{ offer_id: runner.offer_id, quantity: 2, size: "42" }],
          submit: false,
          contact: { note: "Size: 42" },
        },
      });
    });

    it("drafts the order from a Russian size answer and keeps the RU button name", () => {
      const asked = [
        user("Хочу заказать Runner"),
        ...toolTurn("search_offers", {}, { total: 1, offers: [runner] }),
        assistant("Какой размер? Есть: 41, 42."),
      ];
      const [call] = calls(decide([...asked, user("42 размер")], "k"));
      expect(call?.arguments.contact).toEqual({ note: "Size: 42" });
      const draft = [
        ...asked,
        user("42 размер"),
        ...toolTurn(
          "create_order",
          {},
          {
            status: "draft",
            items: [{ title: "Runner", quantity: 1, size: "42" }],
            total_label: "100 KZT",
          },
        ),
      ];
      const text = reply(decide(draft, "x"));
      expect(text).toContain("Runner (размер 42) x 1");
      expect(text).toContain("«Подтвердить заказ»");
    });

    it("asks again for a size that is not offered and cancels on no", () => {
      const asked = [...buyEn, assistant("Which size? Available: 41, 42.")];
      expect(reply(decide([...asked, user("50")], "k"))).toBe("Which size? Available: 41, 42.");
      expect(reply(decide([...asked, user("no")], "k"))).toContain("did not place the order");
    });
  });

  it("shows the size in the draft and passes it as a note", () => {
    const search = [
      user("хочу купить Runner, размер 42"),
      ...toolTurn("search_offers", {}, { total: 1, offers: [runner] }),
    ];
    const [call] = calls(decide(search, "key-1234567"));
    expect(call?.arguments.contact).toEqual({ note: "Size: 42" });
    const draft = [
      ...search,
      ...toolTurn(
        "create_order",
        {},
        {
          status: "draft",
          items: [{ title: "Runner", quantity: 1, size: "42" }],
          total_label: "100 KZT",
        },
      ),
    ];
    expect(reply(decide(draft, "x"))).toContain("Runner (размер 42) x 1");
  });

  describe("order details conversation", () => {
    const prompts = {
      en: 'Your order: Runner x 1. Total 100 KZT. It is not placed yet. To place it, press "Confirm order" below, or tell me your name, phone number and whether you want pickup or delivery (with the address). Reply no to cancel.',
      ru: "Ваш заказ: Runner x 1. Итого 100 KZT. Он ещё не оформлен. Чтобы оформить, нажмите «Подтвердить заказ» ниже или напишите имя, телефон и что вам удобнее: самовывоз или доставка (с адресом). Ответьте нет, чтобы отменить.",
    };
    const phone = "+7 701 000 11 22";
    const order = (earlier: string[] = [], lang: "en" | "ru" = "en"): LlmMessage[] => [
      ...earlier.map((text) => user(text)),
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "c2",
            name: "create_order",
            arguments: {
              idempotency_key: "key-1234567",
              items: [{ offer_id: runner.offer_id, quantity: 1 }],
              submit: false,
            },
          },
        ],
      },
      { role: "tool", toolCallId: "c2", name: "create_order", content: "{}" },
      assistant(prompts[lang]),
    ];
    const argsOf = (history: LlmMessage[]) => calls(decide(history, "k"))[0]?.arguments;
    const talk = (history: LlmMessage[], ...turns: string[]): LlmMessage[] => {
      const out = [...history];
      for (const turn of turns) {
        out.push(user(turn));
        const next = decide(out, "k");
        if ("reply" in next) out.push(assistant(next.reply));
      }
      return out;
    };

    it("recognises the pending order after the summary", () => {
      expect(readContext(order()).pending).toMatchObject({
        kind: "order",
        key: "key-1234567",
        asking: null,
      });
    });

    it("asks for the details one by one after a yes", () => {
      const history = order();
      expect(reply(decide([...history, user("yes")], "k"))).toBe("What is your name?");
      const named = talk(history, "yes");
      expect(reply(decide([...named, user("Aidar")], "k"))).toBe(
        "What phone number can the store reach you at?",
      );
      const phoned = talk(history, "yes", "Aidar");
      expect(reply(decide([...phoned, user(phone)], "k"))).toBe(
        "Would you like pickup or delivery?",
      );
      const chosen = talk(history, "yes", "Aidar", phone);
      expect(reply(decide([...chosen, user("delivery")], "k"))).toBe(
        "What is the delivery address?",
      );
    });

    it("sends a pickup order once everything is collected", () => {
      const history = talk(order(), "yes", "Aidar", phone);
      expect(argsOf([...history, user("pickup")])).toEqual({
        idempotency_key: "key-1234567",
        items: [{ offer_id: runner.offer_id, quantity: 1 }],
        submit: true,
        contact: { name: "Aidar", phone },
        fulfillment: "pickup",
      });
    });

    it("sends a delivery order with the address", () => {
      const history = talk(order(), "yes", "Aidar Nurlanuly", phone, "delivery");
      expect(reply(decide([...history, user("Abay 10, apartment 5")], "k"))).toBe(
        "What city is the delivery to?",
      );
      const addressed = talk(history, "Abay 10, apartment 5");
      expect(argsOf([...addressed, user("Almaty")])).toEqual({
        idempotency_key: "key-1234567",
        items: [{ offer_id: runner.offer_id, quantity: 1 }],
        submit: true,
        contact: { name: "Aidar Nurlanuly", phone },
        fulfillment: "delivery",
        delivery_address: "Abay 10, apartment 5",
        city: "Almaty",
      });
    });

    it("takes the city from the address message and asks for it only on delivery", () => {
      const history = talk(order(), "yes", "Aidar", phone, "delivery");
      expect(argsOf([...history, user("Abay 10, city Almaty")])).toMatchObject({
        submit: true,
        delivery_address: "Abay 10",
        city: "Almaty",
      });
      const pickup = talk(order(), "yes", "Aidar", phone);
      const sent = argsOf([...pickup, user("pickup")]);
      expect(sent).toMatchObject({ submit: true, fulfillment: "pickup" });
      expect(sent).not.toHaveProperty("city");
    });

    it("takes all details given in one message and skips the questions", () => {
      expect(
        argsOf([
          ...order(),
          user("my name is Aidar Nurlanuly, +7 701 000 11 22, delivery to Abay 10, city Almaty"),
        ]),
      ).toMatchObject({
        submit: true,
        contact: { name: "Aidar Nurlanuly", phone },
        fulfillment: "delivery",
        delivery_address: "Abay 10",
        city: "Almaty",
      });
      expect(
        argsOf([...order(), user("I am Dana, +7 701 000 11 22, I will pick up")]),
      ).toMatchObject({ contact: { name: "Dana", phone }, fulfillment: "pickup" });
    });

    it("asks only for what is still missing", () => {
      expect(reply(decide([...order(), user("yes, my name is Dana")], "k"))).toBe(
        "What phone number can the store reach you at?",
      );
      expect(reply(decide([...order(), user(phone)], "k"))).toBe("What is your name?");
      expect(reply(decide([...order(), user("my name is Dana, " + phone)], "k"))).toBe(
        "Would you like pickup or delivery?",
      );
      expect(
        reply(decide([...order(), user("my name is Dana, " + phone + ", delivery")], "k")),
      ).toBe("What is the delivery address?");
    });

    it("takes details given earlier in the conversation", () => {
      const history = order(["my name is Dana", "me@example.com"]);
      expect(reply(decide([...history, user("yes")], "k"))).toBe(
        "What phone number can the store reach you at?",
      );
      expect(argsOf([...history, user("yes, " + phone + ", pickup")])).toMatchObject({
        contact: { name: "Dana", phone, email: "me@example.com" },
        fulfillment: "pickup",
      });
    });

    it("puts the size in the order note", () => {
      const history = talk(order(["size 43"]), "yes", "Aidar", phone);
      expect(argsOf([...history, user("pickup")])?.contact).toEqual({
        name: "Aidar",
        phone,
        note: "Size: 43",
      });
    });

    it("does not send without the details and cancels on no", () => {
      expect(reply(decide([...order(), user("no")], "k"))).toContain("did not place the order");
      const asked = talk(order(), "yes");
      expect(reply(decide([...asked, user("no")], "k"))).toContain("did not place the order");
      const other = decide([...asked, user("what is the weather?")], "k");
      expect("reply" in other ? other.reply : "").not.toContain("sent to the store");
    });

    it("runs the whole flow in Russian", () => {
      const history = order([], "ru");
      expect(reply(decide([...history, user("да")], "k"))).toBe("Как вас зовут?");
      const named = talk(history, "да");
      expect(reply(decide([...named, user("Айдар")], "k"))).toBe(
        "На какой номер телефона магазин может вам позвонить?",
      );
      const phoned = talk(history, "да", "Айдар");
      expect(reply(decide([...phoned, user(`номер ${phone}`)], "k"))).toBe(
        "Вам нужен самовывоз или доставка?",
      );
      const chosen = talk(history, "да", "Айдар", `номер ${phone}`);
      expect(reply(decide([...chosen, user("доставка")], "k"))).toBe("Какой адрес доставки?");
      const addressed = talk(history, "да", "Айдар", `номер ${phone}`, "доставка");
      expect(reply(decide([...addressed, user("ул. Абая 10, кв. 5")], "k"))).toBe(
        "В какой город доставить?",
      );
      const cityAsked = talk(
        history,
        "да",
        "Айдар",
        `номер ${phone}`,
        "доставка",
        "ул. Абая 10, кв. 5",
      );
      expect(argsOf([...cityAsked, user("Алматы")])).toEqual({
        idempotency_key: "key-1234567",
        items: [{ offer_id: runner.offer_id, quantity: 1 }],
        submit: true,
        contact: { name: "Айдар", phone },
        fulfillment: "delivery",
        delivery_address: "ул. Абая 10, кв. 5",
        city: "Алматы",
      });
      expect(argsOf([...chosen, user("самовывоз")])).toMatchObject({
        fulfillment: "pickup",
        contact: { name: "Айдар", phone },
      });
    });

    it("understands Russian name phrases in one message", () => {
      expect(
        argsOf([...order([], "ru"), user("меня зовут Айдар, +7 701 000 11 22, самовывоз")]),
      ).toMatchObject({ contact: { name: "Айдар", phone }, fulfillment: "pickup" });
    });

    it("keeps Russian for a phone-only reply in a Russian chat", () => {
      const history = order(["покажи кроссовки"], "ru");
      expect(reply(decide([...history, user(phone)], "k"))).toBe("Как вас зовут?");
    });

    it("keeps English for a phone-only reply in an English chat", () => {
      const history = order(["show me the sneakers"], "en");
      expect(reply(decide([...history, user(phone)], "k"))).toBe("What is your name?");
    });

    it("uses the latest letter-bearing message when the chat is tied", () => {
      const english = order(["покажи кроссовки", "show me the sneakers"], "en");
      expect(reply(decide([...english, user(phone)], "k"))).toBe("What is your name?");
      const russian = order(["show me the sneakers", "покажи кроссовки"], "ru");
      expect(reply(decide([...russian, user(phone)], "k"))).toBe("Как вас зовут?");
    });
  });

  it("explains a product that cannot be ordered and offers the owner", () => {
    const messages = [
      user("buy the custom boot"),
      ...toolTurn("search_offers", {}, { total: 1, offers: [quote] }),
    ];
    const text = reply(decide(messages, "k"));
    expect(text).toContain("cannot be ordered online");
    expect(text).toContain("pass this to the store owner");
  });

  it("asks which product when several match a buy request", () => {
    const messages = [
      user("buy shoes"),
      ...toolTurn("search_offers", {}, { total: 2, offers: [runner, quote] }),
    ];
    expect(reply(decide(messages, "k"))).toContain("Which one");
  });

  it("hands the question to the owner on yes and on a contact", () => {
    const history = [
      user("do you sell tents?"),
      assistant(
        "I could not find that in the catalog. Would you like me to pass this to the store owner? Reply yes, or send a phone number or email so they can reach you.",
      ),
    ];
    const [yes] = calls(decide([...history, user("yes")], "k"));
    expect(yes?.name).toBe("submit_inquiry");
    expect(yes?.arguments).toMatchObject({ subject: "do you sell tents?" });
    expect(yes?.arguments.contact).toBeUndefined();

    const [withContact] = calls(decide([...history, user("me@example.com")], "k"));
    expect(withContact?.arguments).toMatchObject({ contact: { email: "me@example.com" } });
  });

  it("asks for contact details after an inquiry without one", () => {
    const messages = [
      user("talk to the owner"),
      assistant(
        "Of course. Would you like me to pass this to the store owner? Reply yes, or send a phone number or email so they can reach you.",
      ),
      user("yes"),
      ...toolTurn("submit_inquiry", { subject: "x" }, { inquiry_id: "i1", status: "open" }),
    ];
    const text = reply(decide(messages, "k"));
    expect(text).toContain("sent to the store owner");
    expect(text).toContain("phone number or email");
  });

  it("reports a failed tool instead of inventing an answer", () => {
    const messages: LlmMessage[] = [
      user("how much is the Runner"),
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "c1", name: "search_offers", arguments: {} }],
      },
      { role: "tool", toolCallId: "c1", name: "search_offers", content: "internal_error: boom" },
    ];
    expect(reply(decide(messages, "k"))).toContain("could not do that");
  });
});

const services = testServices();

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const model: BusinessModelInput = {
  profile: { name: "Shoe Shop", description: "Shoes", contacts: { phone: "+77001112233" } },
  offer_types: [{ key: "shoes", name: "Shoes", kind: "product", attributes: [] }],
  offers: [
    {
      title: "Runner",
      offer_type: "shoes",
      price: 100,
      currency: "KZT",
      price_status: "confirmed",
      availability: "in_stock",
    },
    { title: "Custom boot", offer_type: "shoes", price_status: "on_request" },
  ],
};

describe("storefront chat without a model", () => {
  it("answers, drafts, confirms an order and files an inquiry", async () => {
    const ctx = await createTestTenant({ live: true });
    await services.catalog.applyBusinessModel({ ...ctx, actor: "system" }, model);
    const cookie = `sf_session=${newChatSession()}`;

    async function say(message: string) {
      const res = await handleChatMessage(
        new Request("http://localhost/chat", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ message }),
        }),
        ctx.slug,
        services,
        null,
      );
      expect(res.status).toBe(200);
      const lines = (await res.text()).split("\n").filter(Boolean);
      return lines.map((line) => JSON.parse(line) as { type: string; [key: string]: unknown });
    }
    const messageOf = (events: { type: string; content?: unknown }[]) =>
      String(events.find((e) => e.type === "message")?.content);

    expect(messageOf(await say("do you have a runner?"))).toContain("Runner");
    expect(messageOf(await say("how much is the custom boot"))).toContain("Price on request");

    const draft = await say("buy the Runner");
    const order = draft.find((e) => e.type === "tool_result" && e.name === "create_order");
    expect(order).toBeDefined();
    expect(messageOf(draft)).toContain("Confirm order");
    expect(await services.orders.listOrders(ctx)).toMatchObject([{ status: "draft" }]);

    expect(messageOf(await say("yes"))).toContain("What is your name?");
    expect(messageOf(await say("Aidar"))).toContain("What phone number");
    expect(messageOf(await say("+7 701 000 11 22"))).toContain("pickup or delivery");
    expect(messageOf(await say("delivery"))).toContain("delivery address");
    expect(await services.orders.listOrders(ctx)).toMatchObject([{ status: "draft" }]);
    expect(messageOf(await say("Abay 10"))).toContain("city");
    expect(await services.orders.listOrders(ctx)).toMatchObject([{ status: "draft" }]);
    expect(messageOf(await say("Almaty"))).toContain("sent to the store");
    expect(await services.orders.listOrders(ctx)).toMatchObject([
      {
        status: "submitted",
        contact: { name: "Aidar", phone: "+7 701 000 11 22" },
        fulfillment: "delivery",
        deliveryAddress: "Abay 10",
        city: "Almaty",
      },
    ]);

    expect(messageOf(await say("do you sell tents?"))).toContain("pass this to the store owner");
    expect(messageOf(await say("me@example.com"))).toContain("sent to the store owner");
    const inquiries = await services.orders.listInquiries(ctx);
    expect(inquiries).toHaveLength(1);
    expect(inquiries[0]).toMatchObject({
      subject: "do you sell tents?",
      contact: { email: "me@example.com" },
    });
    expect(inquiries[0]?.conversationId).not.toBeNull();

    const [conversation] = await services.conversations.list(ctx, { channel: "storefront" });
    const rows = await services.conversations.listMessages(ctx, conversation!.id);
    expect(rows.filter((r) => r.role === "user")).toHaveLength(11);
    expect(rows.filter((r) => r.role === "assistant" && r.content)).toHaveLength(11);
  });
});
