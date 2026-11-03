import { describe, expect, it } from "vitest";
import { actionLabel, auditChange } from "@/server/owner/audit";
import {
  buildInbox,
  countBuckets,
  formatWhen,
  bucketCounts,
  inquiryItem,
  formatCursor,
  mergeKeyset,
  parseCursor,
  pageCountOf,
  parsePage,
  orderItem,
  orderNumber,
  parseFilter,
  transcript,
} from "@/server/owner/inbox";
import type { Message } from "@/server/services/conversations";
import type { Inquiry, Order } from "@/server/services/orders";

const T0 = new Date("2026-11-02T09:00:00Z");

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "a1b2c3d4-0000-4000-8000-000000000001",
    tenantId: "t",
    conversationId: "c1",
    items: [
      {
        offerId: "o1",
        title: "Trail Runner",
        quantity: 1,
        unitPrice: 72000,
        currency: "KZT",
        lineTotal: 72000,
      },
    ],
    contact: { name: "Aidar", phone: "+7 701 555 01 42" },
    fulfillment: "pickup",
    deliveryAddress: null,
    city: null,
    cancelReason: null,
    status: "submitted",
    source: "storefront",
    idempotencyKey: "key-00001",
    total: 72000,
    currency: "KZT",
    createdAt: T0,
    updatedAt: T0,
    submittedAt: T0,
    ...overrides,
  };
}

function inquiry(overrides: Partial<Inquiry> = {}): Inquiry {
  return {
    id: "i1",
    tenantId: "t",
    conversationId: "c2",
    subject: "Price of Carbon Racer in 43",
    details: "",
    contact: { email: "dana@example.com" },
    status: "new",
    answer: null,
    answeredAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

describe("inbox items", () => {
  it("describes an order with steps, next action and facts", () => {
    const item = orderItem(order());
    expect(item).toMatchObject({
      key: "order:a1b2c3d4-0000-4000-8000-000000000001",
      label: "Order A1B2C3",
      who: "Aidar",
      source: "Storefront chat",
      bucket: "new",
      statusLabel: "Submitted",
      preview: "Trail Runner · 72 000 ₸",
      next: { status: "received", label: "Mark received" },
      canCancel: true,
    });
    expect(item.steps.map((s) => s.state)).toEqual(["current", "todo", "todo", "todo"]);
    expect(item.facts).toEqual([
      { label: "Items", value: "Trail Runner × 1" },
      { label: "Total", value: "72 000 ₸" },
      { label: "Contact", value: "+7 701 555 01 42" },
      { label: "Name", value: "Aidar" },
      { label: "Fulfillment", value: "Pickup" },
    ]);
  });

  it("lists every line with its size and quantity", () => {
    const item = orderItem(
      order({
        items: [
          {
            offerId: "o1",
            title: "Trail Runner",
            quantity: 2,
            unitPrice: 1,
            currency: "KZT",
            lineTotal: 2,
            size: "42",
          },
          {
            offerId: "o2",
            title: "Socks",
            quantity: 1,
            unitPrice: 1,
            currency: "KZT",
            lineTotal: 1,
          },
        ],
      }),
    );
    expect(item.facts[0]).toEqual({
      label: "Items",
      value: "Trail Runner, size 42 × 2; Socks × 1",
    });
  });

  it("lists delivery address with the city and the cancel reason", () => {
    const delivery = orderItem(
      order({ fulfillment: "delivery", deliveryAddress: "Abay 10", city: "Almaty" }),
    );
    expect(delivery.facts).toContainEqual({ label: "Fulfillment", value: "Delivery" });
    expect(delivery.facts).toContainEqual({ label: "Address", value: "Abay 10, Almaty" });

    const noCity = orderItem(order({ fulfillment: "delivery", deliveryAddress: "Abay 10" }));
    expect(noCity.facts).toContainEqual({ label: "Address", value: "Abay 10" });

    const cityOnly = orderItem(order({ fulfillment: "delivery", city: "Almaty" }));
    expect(cityOnly.facts).toContainEqual({ label: "Address", value: "Almaty" });

    const cancelled = orderItem(order({ status: "cancelled", cancelReason: "Out of stock" }));
    expect(cancelled.facts).toContainEqual({ label: "Cancel reason", value: "Out of stock" });

    const plain = orderItem(order({ fulfillment: null })).facts.map((f) => f.label);
    expect(plain).not.toContain("Fulfillment");
    expect(plain).not.toContain("Address");
    expect(plain).not.toContain("Cancel reason");
  });

  it("walks the order through its lifecycle", () => {
    const processing = orderItem(order({ status: "processing" }));
    expect(processing.bucket).toBe("in_progress");
    expect(processing.next?.status).toBe("completed");
    expect(processing.steps.map((s) => s.state)).toEqual(["done", "done", "current", "todo"]);

    const done = orderItem(order({ status: "completed" }));
    expect(done).toMatchObject({ bucket: "completed", next: null, canCancel: false });

    const cancelled = orderItem(order({ status: "cancelled" }));
    expect(cancelled.bucket).toBe("completed");
    expect(cancelled.steps.map((s) => s.state)).toEqual(["todo", "cancelled"]);
  });

  it("names external agent orders and counts several items", () => {
    const item = orderItem(
      order({
        source: "external_agent",
        contact: {},
        items: [
          { offerId: "a", title: "A", quantity: 1, unitPrice: 1, currency: "USD", lineTotal: 1 },
          { offerId: "b", title: "B", quantity: 2, unitPrice: 2, currency: "USD", lineTotal: 4 },
        ],
        total: 5,
        currency: "USD",
      }),
    );
    expect(item).toMatchObject({ who: "External agent", source: "External agent" });
    expect(item.preview).toBe("2 items · $5");
  });

  it("hides draft orders, takes the inquiry source from its chat and sorts newest first", () => {
    const later = new Date(T0.getTime() + 60_000);
    const items = buildInbox(
      [order({ id: "d", status: "draft" }), order({ id: "o" })],
      [inquiry({ createdAt: later }), inquiry({ id: "i2", conversationId: null })],
      new Map([["c2", "external_agent" as const]]),
    );
    expect(items.map((i) => i.key)).toEqual(["inquiry:i1", "order:o", "inquiry:i2"]);
    expect(items[0]).toMatchObject({
      source: "External agent",
      who: "dana@example.com",
      next: { status: "in_progress", label: "Mark in progress" },
    });
    expect(items[2]?.source).toBe("Customer Agent");
    expect(countBuckets(items)).toEqual({ all: 3, new: 3, in_progress: 0, completed: 0 });
  });

  it("shows the answer as a fact and offers no next action once answered", () => {
    const item = inquiryItem(
      inquiry({ status: "completed", answer: "In stock.", answeredAt: T0 }),
      "storefront",
    );
    expect(item.facts).toContainEqual({ label: "Your answer", value: "In stock." });
    expect(item).toMatchObject({ answer: "In stock.", answeredAt: T0, next: null });
    expect(inquiryItem(inquiry({ status: "in_progress", answer: "Hi" })).next).toBeNull();
    expect(inquiryItem(inquiry()).answer).toBeNull();
  });

  it("parses filters and order numbers", () => {
    expect(parseFilter("in_progress")).toBe("in_progress");
    expect(parseFilter("bogus")).toBe("all");
    expect(parseFilter(undefined)).toBe("all");
    expect(orderNumber("0f9e8d7c-1111")).toBe("0F9E8D");
  });
});

describe("transcript", () => {
  it("keeps customer and assistant text only", () => {
    const msg = (role: Message["role"], content: string | null): Message => ({
      id: `${role}-${content}`,
      conversationId: "c",
      role,
      content,
      toolCalls: null,
      createdAt: T0,
    });
    const lines = transcript([
      msg("system", "prompt"),
      msg("user", "Need size 43"),
      msg("assistant", null),
      msg("tool", "{}"),
      msg("assistant", "  In stock.  "),
    ]);
    expect(lines.map((l) => [l.from, l.text])).toEqual([
      ["customer", "Need size 43"],
      ["assistant", "In stock."],
    ]);
  });
});

describe("formatWhen", () => {
  const now = new Date("2026-11-02T15:00:00Z");
  it("shows time today, Yesterday, then a date", () => {
    expect(formatWhen(new Date("2026-11-02T14:09:00Z"), now, "UTC")).toBe("14:09");
    expect(formatWhen(new Date("2026-11-01T08:00:00Z"), now, "UTC")).toBe("Yesterday");
    expect(formatWhen(new Date("2026-10-30T08:00:00Z"), now, "UTC")).toBe("Oct 30");
    expect(formatWhen(new Date("2025-10-30T08:00:00Z"), now, "UTC")).toBe("Oct 30, 2025");
  });
});

describe("audit labels", () => {
  it("labels actions and status changes", () => {
    expect(actionLabel("order.submitted")).toBe("Order confirmed by the buyer");
    expect(actionLabel("custom.thing")).toBe("custom.thing");
    expect(auditChange({ before: { status: "in_progress" }, after: { status: "completed" } })).toBe(
      "in progress → completed",
    );
    expect(auditChange({ before: null, after: { title: "x" } })).toBe("");
  });
});

describe("inbox paging", () => {
  const at = (minutes: number) => new Date(T0.getTime() - minutes * 60000);
  const orders = Array.from({ length: 5 }, (_, i) =>
    order({ id: `a1b2c3d4-0000-4000-8000-00000000000${i}`, submittedAt: at(i * 2) }),
  );
  const questions = Array.from({ length: 5 }, (_, i) =>
    inquiry({ id: `q${i}`, createdAt: at(i * 2 + 1) }),
  );

  const afterCursor = <T extends { id: string }>(
    rows: T[],
    time: (row: T) => Date,
    cursor: { at: number; id: string } | null,
  ) =>
    rows.filter(
      (row) =>
        !cursor ||
        time(row).getTime() < cursor.at ||
        (time(row).getTime() === cursor.at && row.id < cursor.id),
    );

  function walk(os: Order[], qs: Inquiry[], size: number): string[][] {
    const sortedO = [...os].sort(
      (a, b) =>
        (b.submittedAt ?? b.createdAt).getTime() - (a.submittedAt ?? a.createdAt).getTime() ||
        (a.id < b.id ? 1 : -1),
    );
    const sortedQ = [...qs].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1),
    );
    const pages: string[][] = [];
    let cursor: { at: number; id: string } | null = null;
    for (;;) {
      const o = afterCursor(sortedO, (r) => r.submittedAt ?? r.createdAt, cursor).slice(
        0,
        size + 1,
      );
      const q = afterCursor(sortedQ, (r) => r.createdAt, cursor).slice(0, size + 1);
      const { items, next } = mergeKeyset(o, q, size);
      pages.push(items.map((i) => i.key));
      if (!next) return pages;
      cursor = next;
    }
  }

  it("interleaves both sources newest first", () => {
    const first = mergeKeyset(orders.slice(0, 5), questions.slice(0, 5), 4);
    expect(first.items.map((i) => i.kind)).toEqual(["order", "inquiry", "order", "inquiry"]);
    expect(first.next).toEqual({ at: at(3).getTime(), id: "q1" });
    expect(mergeKeyset([], [], 4)).toEqual({ items: [], next: null });
  });

  it("walks every item once across pages, including equal timestamps", () => {
    const tie = (n: number) =>
      order({ id: `a1b2c3d4-0000-4000-8000-0000000001${n}0`, submittedAt: T0 });
    const tied = [tie(1), tie(2), tie(3)];
    const tiedQ = [0, 1, 2].map((n) => inquiry({ id: `t${n}`, createdAt: T0 }));
    const os = [...tied, ...orders];
    const qs = [...tiedQ, ...questions];
    for (const size of [1, 2, 3, 4, 7]) {
      const keys = walk(os, qs, size).flat();
      const all = mergeKeyset(os, qs, 100).items.map((i) => i.key);
      expect(keys).toEqual(all);
      expect(new Set(keys).size).toBe(os.length + qs.length);
    }
  });

  it("round trips cursors and rejects bad ones", () => {
    const cursor = { at: T0.getTime(), id: "a1b2c3d4-0000-4000-8000-000000000001" };
    expect(parseCursor(formatCursor(cursor))).toEqual(cursor);
    expect(parseCursor("abc_def")).toBeNull();
    expect(parseCursor("123_a1b2c3d4-0000-4000-8000-000000000001_x")).toBeNull();
    expect(parseCursor(undefined)).toBeNull();
  });

  it("counts buckets from status totals", () => {
    const counts = bucketCounts(
      { draft: 3, submitted: 2, received: 1, processing: 1, completed: 4, cancelled: 1 },
      { new: 2, in_progress: 1, completed: 5 },
    );
    expect(counts).toEqual({ all: 17, new: 4, in_progress: 3, completed: 10 });
  });

  it("computes page counts and parses the page param", () => {
    expect(pageCountOf(0)).toBe(1);
    expect(pageCountOf(30)).toBe(1);
    expect(pageCountOf(31)).toBe(2);
    expect(pageCountOf(100000)).toBe(3334);
    expect(parsePage("3")).toBe(3);
    expect(parsePage("0")).toBe(1);
    expect(parsePage("abc")).toBe(1);
    expect(parsePage(undefined)).toBe(1);
  });
});
