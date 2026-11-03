import { describe, expect, it } from "vitest";
import { shoeStoreModel } from "@/db/seed-data/shoe-store";
import { handleChatMessage } from "@/server/storefront/chat";
import { decide, extractBudget, parseIntent } from "@/server/storefront/fallback-assistant";
import { createTestTenant } from "../helpers/db";
import { testServices } from "../helpers/mcp";

const services = testServices();

describe("extractBudget", () => {
  it.each([
    ["кроссовки до 75 000", 75000],
    ["кроссовки до 75000 тенге", 75000],
    ["до 1 500 000", 1500000],
    ["кроссовки 75000-ге дейін", 75000],
    ["75 000 теңгеге дейін", 75000],
    ["sneakers under 75k", 75000],
    ["sneakers under 75 000", 75000],
    ["boots up to 60000", 60000],
    ["не дороже 80 тыс", 80000],
    ["ботинки 75 тыс", 75000],
    ["sneakers 75k", 75000],
    ["budget 1.5k", 1500],
    ["бюджет 50000", 50000],
  ])("reads the limit in %j", (text, maxPrice) => {
    expect(extractBudget(text).maxPrice).toBe(maxPrice);
  });

  it.each(["sneakers size 43", "до 43", "размер 43", "buy 2 pairs", "hello"])(
    "finds no limit in %j",
    (text) => {
      expect(extractBudget(text).maxPrice).toBeNull();
    },
  );

  it("removes the budget phrase from the search terms", () => {
    const intent = parseIntent("кроссовки до 75 тыс");
    expect(intent.maxPrice).toBe(75000);
    expect(intent.terms).toEqual(["кроссов"]);
    expect(parseIntent("sneakers under 75k").terms).toEqual(["sneaker"]);
  });
});

describe("shoe size in a search", () => {
  it.each([
    ["sneakers size 43", "43"],
    ["кроссовки 43 размер", "43"],
    ["sneakers 43", "43"],
    ["sneakers eu 42.5", "42.5"],
  ])("reads the size in %j", (text, size) => {
    expect(parseIntent(text).size).toBe(size);
  });

  it("does not take a quantity, a price or a model number for a size", () => {
    expect(parseIntent("order 40 pcs of sneakers").size).toBeNull();
    expect(parseIntent("sneakers under 45000").size).toBeNull();
    expect(parseIntent("Air Max 90").size).toBeNull();
  });
});

function search(text: string) {
  return decide([{ role: "user", content: text }], "k");
}

describe("search arguments", () => {
  it("passes the budget and the size to the catalog search", () => {
    expect(search("sneakers under 45k size 43")).toEqual({
      calls: [
        {
          name: "find_offers",
          arguments: { intent: "sneakers under 45k size 43", lang: "en" },
        },
      ],
    });
  });

  it("searches by budget alone", () => {
    expect(search("до 45 000")).toMatchObject({
      calls: [{ name: "find_offers", arguments: { intent: "до 45 000", lang: "ru" } }],
    });
  });

  it("sends a plain query as it is", () => {
    expect(search("sneakers")).toEqual({
      calls: [{ name: "find_offers", arguments: { intent: "sneakers", lang: "en" } }],
    });
  });

  it("does not filter when the shopper wants to buy", () => {
    expect(search("buy sneakers size 43")).toMatchObject({
      calls: [{ name: "find_offers", arguments: { intent: "sneaker", lang: "en" } }],
    });
  });
});

async function reply(text: string) {
  const ctx = await createTestTenant({ live: true });
  await services.catalog.applyBusinessModel({ ...ctx, actor: "system" }, shoeStoreModel);
  const response = await handleChatMessage(
    new Request("http://localhost/api/s/x/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text }),
    }),
    ctx.slug,
    services,
    null,
  );
  const lines = (await response.text()).split("\n").filter(Boolean);
  const events = lines.map((line) => JSON.parse(line) as { type: string; content?: string });
  return events.find((e) => e.type === "message")?.content ?? "";
}

describe("budget reply", () => {
  it("lists priced offers within the budget and the on-request ones apart (en)", async () => {
    const text = await reply("sneakers under 45k size 43");
    const [priced, onRequest] = text.split("The price of these is on request");
    expect(priced).toContain("Within 45 000:");
    expect(priced).toContain("Nordix Air Street Sneakers: 42,000 KZT, in stock");
    expect(priced).toContain("Nordix Hightop Classic");
    expect(priced).not.toContain("Velor Retro");
    expect(priced).not.toContain("Lumia Platform");
    expect(onRequest).toContain("Kazbek Limited Edition Sneakers");
    expect(onRequest).not.toContain("Nordix");
  });

  it("answers in Russian", async () => {
    const text = await reply("кроссовки до 45 000");
    expect(text).toContain("В пределах 45 000:");
    expect(text).toContain("Цена этих товаров по запросу");
    expect(text).toContain("Kazbek Limited Edition Sneakers");
  });

  it("answers in Kazakh", async () => {
    const text = await reply("кроссовки 45000-ге дейін, 43 өлшем");
    expect(text).toContain("45 000 дейін:");
    expect(text).toContain("Бұл тауарлардың бағасы сұраныс бойынша");
    expect(text).toContain("Kazbek Limited Edition Sneakers");
  });

  it("says so when nothing priced fits but an on-request offer matches", async () => {
    const text = await reply("sneakers under 5000");
    expect(text).toContain("No offer with a confirmed price is within 5 000.");
    expect(text).toContain("Kazbek Limited Edition Sneakers");
  });
});
