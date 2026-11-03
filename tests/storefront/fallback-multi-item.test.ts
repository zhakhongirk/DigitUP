import { describe, expect, it } from "vitest";
import type { LlmMessage } from "@/server/llm";
import { decide, readContext, type Decision } from "@/server/storefront/fallback-assistant";

const user = (content: string): LlmMessage => ({ role: "user", content });
const assistant = (content: string): LlmMessage => ({ role: "assistant", content });
function toolTurn(name: string, args: Record<string, unknown>, data: unknown): LlmMessage[] {
  return [
    { role: "assistant", content: null, toolCalls: [{ id: "c1", name, arguments: args }] },
    { role: "tool", toolCallId: "c1", name, content: JSON.stringify(data) },
  ];
}
const reply = (decision: Decision): string => {
  if (!("reply" in decision)) throw new Error("expected a reply");
  return decision.reply;
};
const calls = (decision: Decision) => {
  if (!("calls" in decision)) throw new Error("expected tool calls");
  return decision.calls;
};

const runner = {
  offer_id: "00000000-0000-4000-8000-000000000001",
  title: "Runner",
  price_status: "confirmed",
  price_label: "100 KZT",
  availability: "in_stock",
  can_order: true,
  attributes: { sizes: ["41", "42"] },
};
const samba = {
  offer_id: "00000000-0000-4000-8000-000000000003",
  title: "Samba",
  price_status: "confirmed",
  price_label: "80 KZT",
  availability: "in_stock",
  can_order: true,
  attributes: { sizes: ["38", "39"] },
};
const cap = {
  offer_id: "00000000-0000-4000-8000-000000000004",
  title: "Cap",
  price_status: "confirmed",
  price_label: "20 KZT",
  availability: "in_stock",
  can_order: true,
  attributes: {},
};

const draftOf = (items: Record<string, unknown>[], total = "180 KZT") => ({
  order_id: "o1",
  status: "draft",
  items,
  total_label: total,
});
const runnerLine = { offerId: runner.offer_id, title: "Runner", quantity: 1, size: "42" };
const sambaLine = { offerId: samba.offer_id, title: "Samba", quantity: 1, size: "39" };

const prompt =
  'It is not placed yet. To place it, press "Confirm order" below, or tell me your name, phone number and whether you want pickup or delivery (with the address). Reply no to cancel.';

function firstOrder(): LlmMessage[] {
  return [
    user("buy Runner size 42"),
    ...toolTurn("search_offers", {}, { total: 1, offers: [runner] }),
    {
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "c2",
          name: "create_order",
          arguments: {
            idempotency_key: "key-1234567",
            items: [{ offer_id: runner.offer_id, quantity: 1, size: "42" }],
            submit: false,
          },
        },
      ],
    },
    {
      role: "tool",
      toolCallId: "c2",
      name: "create_order",
      content: JSON.stringify(draftOf([runnerLine], "100 KZT")),
    },
    assistant(`Your order: Runner (size 42) x 1. Total 100 KZT. ${prompt}`),
  ];
}

function twoItemOrder(): LlmMessage[] {
  return [
    ...firstOrder(),
    ...toolTurn(
      "create_order",
      { idempotency_key: "key-1234567" },
      draftOf([runnerLine, sambaLine]),
    ),
    assistant(`Your order: Runner (size 42) x 1, Samba (size 39) x 1. Total 180 KZT. ${prompt}`),
  ];
}

describe("several items in one order", () => {
  it("puts the size on the item and in the note", () => {
    const search = [
      user("buy Runner size 42"),
      ...toolTurn("search_offers", {}, { total: 1, offers: [runner] }),
    ];
    const [call] = calls(decide(search, "key-1234567"));
    expect(call?.arguments).toEqual({
      idempotency_key: "key-1234567",
      items: [{ offer_id: runner.offer_id, quantity: 1, size: "42" }],
      submit: false,
      contact: { note: "Size: 42" },
    });
  });

  it("recognises the open draft with its items", () => {
    const context = readContext(firstOrder());
    expect(context.draft).toEqual({
      key: "key-1234567",
      items: [{ offer_id: runner.offer_id, title: "Runner", quantity: 1, size: "42" }],
    });
    expect(context.pending).toMatchObject({ kind: "order", key: "key-1234567" });
  });

  it("searches for the product to add and then asks for its size", () => {
    const history = [...firstOrder(), user("also add Samba")];
    const [search] = calls(decide(history, "k"));
    expect(search).toEqual({ name: "search_offers", arguments: { query: "samba", limit: 6 } });
    const found = [...history, ...toolTurn("search_offers", {}, { total: 1, offers: [samba] })];
    expect(reply(decide(found, "k"))).toBe("Which size? Available: 38, 39.");
  });

  it("merges the added item into the same draft with the chosen size", () => {
    const asked = [
      ...firstOrder(),
      user("add 2 Samba"),
      ...toolTurn("search_offers", {}, { total: 1, offers: [samba] }),
      assistant("Which size? Available: 38, 39."),
    ];
    expect(readContext(asked).pending).toMatchObject({
      kind: "size",
      quantity: 2,
      title: "Samba",
      draft: { key: "key-1234567" },
    });
    const [call] = calls(decide([...asked, user("39")], "other-key"));
    expect(call?.arguments).toEqual({
      idempotency_key: "key-1234567",
      items: [{ offer_id: samba.offer_id, quantity: 2, size: "39" }],
      merge: true,
      submit: false,
      contact: { note: "Sizes: Runner 42; Samba 39" },
    });
  });

  it("adds an item without sizes straight away", () => {
    const history = [
      ...firstOrder(),
      user("и ещё кепку"),
      ...toolTurn("search_offers", {}, { total: 1, offers: [cap] }),
    ];
    const [call] = calls(decide(history, "k"));
    expect(call?.arguments).toMatchObject({
      idempotency_key: "key-1234567",
      items: [{ offer_id: cap.offer_id, quantity: 1 }],
      merge: true,
      submit: false,
    });
  });

  it("shows all items and the total in the summary", () => {
    const history = [
      ...firstOrder(),
      user("add Cap"),
      ...toolTurn("search_offers", {}, { total: 1, offers: [cap] }),
      ...toolTurn(
        "create_order",
        {},
        draftOf(
          [runnerLine, { offerId: cap.offer_id, title: "Cap", quantity: 2 }, sambaLine],
          "320 KZT",
        ),
      ),
    ];
    const text = reply(decide(history, "k"));
    expect(text).toContain("Runner (size 42) x 1, Cap x 2, Samba (size 39) x 1");
    expect(text).toContain("Total 320 KZT");
  });

  it("asks what to add after the button message, then takes the product name", () => {
    const history = [...firstOrder(), user("Add another item")];
    expect(reply(decide(history, "k"))).toBe(
      "Which product would you like to add? Tell me the name.",
    );
    const asked = [...history, assistant("Which product would you like to add? Tell me the name.")];
    expect(readContext(asked).pending).toEqual({ kind: "add" });
    const [search] = calls(decide([...asked, user("Samba")], "k"));
    expect(search?.arguments).toEqual({ query: "samba", limit: 6 });
    const russian = [...firstOrder(), user("Добавить ещё товар")];
    expect(reply(decide(russian, "k"))).toBe("Какой товар добавить? Напишите название.");
  });

  it("removes one item by name and keeps the rest", () => {
    const [call] = calls(decide([...twoItemOrder(), user("remove the Samba")], "k"));
    expect(call?.arguments).toEqual({
      idempotency_key: "key-1234567",
      items: [{ offer_id: runner.offer_id, quantity: 1, size: "42" }],
      submit: false,
      contact: { note: "Size: 42" },
    });
    expect(reply(decide([...twoItemOrder(), user("remove it")], "k"))).toContain(
      "Which item should I remove?",
    );
    expect(reply(decide([...firstOrder(), user("remove the Runner")], "k"))).toContain(
      "did not place the order",
    );
  });

  it("still starts a new order for a plain buy request when a draft is open", () => {
    const history = [
      ...firstOrder(),
      user("buy Samba size 39"),
      ...toolTurn("search_offers", {}, { total: 1, offers: [samba] }),
    ];
    const [call] = calls(decide(history, "fresh-key-123"));
    expect(call?.arguments).toMatchObject({
      idempotency_key: "fresh-key-123",
      items: [{ offer_id: samba.offer_id, quantity: 1, size: "39" }],
    });
    expect(call?.arguments).not.toHaveProperty("merge");
  });

  it("forgets the draft once it was sent", () => {
    const sent = [
      ...firstOrder(),
      ...toolTurn("create_order", { idempotency_key: "key-1234567" }, { status: "submitted" }),
    ];
    expect(readContext(sent).draft).toBeNull();
  });
});

describe("city for delivery", () => {
  const phone = "+7 701 000 11 22";
  const talk = (history: LlmMessage[], ...turns: string[]): LlmMessage[] => {
    const out = [...history];
    for (const turn of turns) {
      out.push(user(turn));
      const next = decide(out, "k");
      if ("reply" in next) out.push(assistant(next.reply));
    }
    return out;
  };

  it("asks for the city after the address and sends it with the order", () => {
    const asked = talk(firstOrder(), "yes", "Aidar", phone, "delivery");
    expect(reply(decide([...asked, user("Abay 10")], "k"))).toBe("What city is the delivery to?");
    const history = talk(asked, "Abay 10");
    const [call] = calls(decide([...history, user("Almaty")], "k"));
    expect(call?.arguments).toMatchObject({
      submit: true,
      fulfillment: "delivery",
      delivery_address: "Abay 10",
      city: "Almaty",
    });
  });

  it("does not ask for the city on pickup", () => {
    const history = talk(firstOrder(), "yes", "Aidar", phone);
    const [call] = calls(decide([...history, user("pickup")], "k"));
    expect(call?.arguments).toMatchObject({ submit: true, fulfillment: "pickup" });
    expect(call?.arguments).not.toHaveProperty("city");
  });
});

describe("Add to order from a product card", () => {
  const tap = (title: string, lang: "en" | "ru" | "kk" = "en") =>
    ({
      en: `Add to order: ${title}`,
      ru: `Добавить в заказ: ${title}`,
      kk: `Тапсырысқа қосу: ${title}`,
    })[lang];
  const found = (offer: Record<string, unknown>) =>
    toolTurn("search_offers", {}, { total: 1, offers: [offer] });
  const capLine = { offerId: cap.offer_id, title: "Cap", quantity: 1 };

  function withCap(): LlmMessage[] {
    return [
      ...firstOrder(),
      user(tap("Cap")),
      ...found(cap),
      ...toolTurn(
        "create_order",
        {
          idempotency_key: "key-1234567",
          items: [{ offer_id: cap.offer_id, quantity: 1 }],
          merge: true,
        },
        draftOf([runnerLine, capLine], "120 KZT"),
      ),
    ];
  }

  it("appends the tapped product as a second line", () => {
    const history = [...firstOrder(), user(tap("Cap")), ...found(cap)];
    const [call] = calls(decide(history, "fresh-key-123"));
    expect(call?.arguments).toMatchObject({
      idempotency_key: "key-1234567",
      items: [{ offer_id: cap.offer_id, quantity: 1 }],
      merge: true,
      submit: false,
    });
  });

  it("confirms with one line and the item count", () => {
    const history = [
      ...firstOrder(),
      user(tap("Cap")),
      ...found(cap),
      {
        role: "assistant" as const,
        content: null,
        toolCalls: [
          {
            id: "c9",
            name: "create_order",
            arguments: {
              idempotency_key: "key-1234567",
              items: [{ offer_id: cap.offer_id, quantity: 1 }],
              merge: true,
              submit: false,
            },
          },
        ],
      },
      {
        role: "tool" as const,
        toolCallId: "c9",
        name: "create_order",
        content: JSON.stringify(draftOf([runnerLine, capLine], "120 KZT")),
      },
    ];
    expect(reply(decide(history, "k"))).toBe("Added Cap × 1. Your order now has 2 items.");
  });

  it("raises the quantity when the same product is tapped again", () => {
    const history = [
      ...withCap(),
      assistant("Added Cap × 1. Your order now has 2 items."),
      user(tap("Cap")),
      ...found(cap),
    ];
    expect(readContext(history.slice(0, -2)).pending).toMatchObject({ kind: "order" });
    const [call] = calls(decide(history, "k"));
    expect(call?.arguments).toMatchObject({
      idempotency_key: "key-1234567",
      items: [{ offer_id: cap.offer_id, quantity: 1 }],
      merge: true,
    });
  });

  it("refuses to go past 20 of one item", () => {
    const full = [
      ...firstOrder(),
      ...toolTurn(
        "create_order",
        { idempotency_key: "key-1234567" },
        draftOf([runnerLine, { ...capLine, quantity: 20 }]),
      ),
      assistant("Added Cap × 20. Your order now has 2 items."),
      user(tap("Cap")),
      ...found(cap),
    ];
    expect(reply(decide(full, "k"))).toBe("You can order up to 20 of one item.");
  });

  it("starts a new draft once the order was sent", () => {
    const sent = [
      ...firstOrder(),
      ...toolTurn("create_order", { idempotency_key: "key-1234567" }, { status: "submitted" }),
      assistant("Order sent."),
      user(tap("Cap")),
      ...found(cap),
    ];
    const [call] = calls(decide(sent, "new-key-12345"));
    expect(call?.arguments).toMatchObject({
      idempotency_key: "new-key-12345",
      items: [{ offer_id: cap.offer_id, quantity: 1 }],
    });
    expect(call?.arguments).not.toHaveProperty("merge");
  });

  it("asks the size for the tapped product and keeps the draft", () => {
    const history = [...firstOrder(), user(tap("Samba")), ...found(samba)];
    expect(reply(decide(history, "k"))).toBe("Which size? Available: 38, 39.");
    const asked = [...history, assistant("Which size? Available: 38, 39.")];
    expect(readContext(asked).pending).toMatchObject({
      kind: "size",
      draft: { key: "key-1234567" },
    });
    const [call] = calls(decide([...asked, user("39")], "k"));
    expect(call?.arguments).toMatchObject({
      idempotency_key: "key-1234567",
      items: [{ offer_id: samba.offer_id, quantity: 1, size: "39" }],
      merge: true,
    });
  });

  it("matches the add-to-order message in every language", () => {
    for (const lang of ["en", "ru", "kk"] as const) {
      const history = [...firstOrder(), user(tap("Cap", lang)), ...found(cap)];
      const [call] = calls(decide(history, "k"));
      expect(call?.arguments).toMatchObject({ merge: true, idempotency_key: "key-1234567" });
    }
  });

  it("confirms in Russian and Kazakh", () => {
    for (const [lang, text] of [
      ["ru", "Добавила Cap × 1. В заказе теперь позиций: 2."],
      ["kk", "Cap × 1 қосылды. Тапсырыста қазір 2 тауар."],
    ] as const) {
      const history = [
        ...firstOrder(),
        user(tap("Cap", lang)),
        ...found(cap),
        {
          role: "assistant" as const,
          content: null,
          toolCalls: [
            {
              id: "c9",
              name: "create_order",
              arguments: {
                idempotency_key: "key-1234567",
                items: [{ offer_id: cap.offer_id, quantity: 1 }],
                merge: true,
              },
            },
          ],
        },
        {
          role: "tool" as const,
          toolCallId: "c9",
          name: "create_order",
          content: JSON.stringify(draftOf([runnerLine, capLine], "120 KZT")),
        },
      ];
      expect(reply(decide(history, "k"))).toBe(text);
    }
  });
});
