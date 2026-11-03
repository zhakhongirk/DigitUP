import { describe, expect, it } from "vitest";
import { actionLabel, auditChange } from "@/server/owner/audit";
import { summarize } from "@/server/owner/changes";
import { formatWhen, orderItem } from "@/server/owner/inbox";
import { cookieValue, langFromRequest, resolveLang } from "@/server/owner/lang-resolve";
import { notificationView } from "@/server/owner/notifications";
import { reviewGaps } from "@/server/onboarding/review";
import { buildSetup, feedSummary, inboxBreakdown } from "@/server/owner/workspace";
import { formatPrice } from "@/shared/format";
import { OWNER_COPY, localizeMessage, tr, trn, type Lang } from "@/shared/owner-copy";
import { businessModelSchema } from "@/shared/business-model";

const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();

describe("owner dictionaries", () => {
  const keys = Object.keys(OWNER_COPY.en);

  it("define the same keys in both languages", () => {
    expect(Object.keys(OWNER_COPY.ru).sort()).toEqual([...keys].sort());
  });

  it("keep the same shape and placeholders for every key", () => {
    for (const key of keys) {
      const en = OWNER_COPY.en[key]!;
      const ru = OWNER_COPY.ru[key]!;
      expect(typeof ru, key).toBe(typeof en);
      if (typeof en === "string" && typeof ru === "string") {
        expect(placeholders(ru), key).toEqual(placeholders(en));
        expect(ru.trim(), key).not.toBe("");
      } else if (typeof en === "object" && typeof ru === "object") {
        for (const form of ["one", "few", "many", "other"] as const) {
          expect(ru[form], `${key}.${form}`).toBeTruthy();
          expect(placeholders(ru[form] ?? ""), `${key}.${form}`).toEqual(placeholders(en.other));
        }
      }
    }
  });

  it("use no em dashes", () => {
    for (const lang of ["en", "ru"] as Lang[]) {
      expect(JSON.stringify(OWNER_COPY[lang])).not.toContain("—");
    }
  });
});

describe("language resolution", () => {
  it("prefers the saved choice over the browser language", () => {
    expect(resolveLang("en", "ru-RU,ru;q=0.9")).toBe("en");
    expect(resolveLang("ru", "en-US")).toBe("ru");
  });

  it("falls back to Accept-Language, treating Kazakh as Russian", () => {
    expect(resolveLang(undefined, "ru-RU,ru;q=0.9,en;q=0.8")).toBe("ru");
    expect(resolveLang(null, "kk-KZ")).toBe("ru");
    expect(resolveLang("garbage", "ru")).toBe("ru");
  });

  it("defaults to English", () => {
    expect(resolveLang(undefined, null)).toBe("en");
    expect(resolveLang("", "de-DE")).toBe("en");
  });

  it("reads the cookie from a request", () => {
    expect(cookieValue("a=1; lang=ru; b=2", "lang")).toBe("ru");
    expect(cookieValue(null, "lang")).toBeUndefined();
    const request = new Request("http://localhost", {
      headers: { cookie: "lang=en", "accept-language": "ru" },
    });
    expect(langFromRequest(request)).toBe("en");
    expect(
      langFromRequest(new Request("http://localhost", { headers: { "accept-language": "ru" } })),
    ).toBe("ru");
  });
});

describe("Russian owner copy", () => {
  it("picks the right plural form", () => {
    expect(trn("ru", "n.order", 1)).toBe("1 заказ");
    expect(trn("ru", "n.order", 3)).toBe("3 заказа");
    expect(trn("ru", "n.order", 5)).toBe("5 заказов");
    expect(trn("ru", "n.order", 21)).toBe("21 заказ");
    expect(trn("en", "n.order", 2)).toBe("2 orders");
  });

  it("renders workspace summaries", () => {
    expect(inboxBreakdown(2, 1, "ru")).toBe("2 заказа, 1 вопрос");
    const view = {
      pendingCount: 1,
      newOrders: 1,
      newInquiries: 1,
      health: { active: 3, priceOnRequest: 2, stockUnknown: 0 },
    };
    expect(feedSummary(view, "ru")).toBe(
      "1 запрос ждёт одобрения и 2 новых во входящих. 2 позиции с ценой по запросу.",
    );
    const items = buildSetup(
      {
        slug: "shop",
        contacts: {},
        policies: {},
        health: view.health,
        activeKeys: 0,
        chatted: false,
      },
      "ru",
    );
    expect(items[1]?.hint).toBe("2 позиции без цены.");
  });

  it("formats dates and money for Russian readers", () => {
    const now = new Date("2026-11-02T15:00:00Z");
    expect(formatWhen(new Date("2026-11-01T08:00:00Z"), now, "UTC", "ru")).toBe("Вчера");
    expect(formatWhen(new Date("2026-11-02T14:09:00Z"), now, "UTC", "ru")).toBe("14:09");
    expect(formatWhen(new Date("2026-10-30T08:00:00Z"), now, "UTC", "ru")).toMatch(/30\s+окт/);
    expect(formatPrice(42000.5, "KZT", "ru")).toBe("42 000,50 ₸");
    expect(formatPrice(42000.5, "KZT")).toBe("42 000.50 ₸");
  });

  it("translates inbox items, audit rows, notifications and change summaries", () => {
    const item = orderItem(
      {
        id: "12345678-aaaa-bbbb-cccc-1234567890ab",
        status: "submitted",
        source: "storefront",
        items: [{ title: "Runner", quantity: 2 }],
        contact: { name: "Aigerim" },
        total: 10000,
        currency: "KZT",
        fulfillment: "delivery",
        deliveryAddress: "Abay 10",
        city: null,
        cancelReason: null,
        conversationId: null,
        submittedAt: new Date("2026-11-02T10:00:00Z"),
        createdAt: new Date("2026-11-02T10:00:00Z"),
      } as unknown as Parameters<typeof orderItem>[0],
      "ru",
    );
    expect(item.label).toBe("Заказ 123456");
    expect(item.statusLabel).toBe("Оформлен");
    expect(item.next?.label).toBe("Принять заказ");
    expect(item.source).toBe("Чат на витрине");
    expect(item.facts).toContainEqual({ label: "Получение", value: "Доставка" });
    expect(item.preview).toBe("Runner · 10 000 ₸");

    expect(actionLabel("order.status_changed", "ru")).toBe("Изменён статус заказа");
    expect(actionLabel("unknown.action", "ru")).toBe("unknown.action");
    expect(
      auditChange({ before: { status: "submitted" }, after: { status: "in_progress" } }, "ru"),
    ).toBe("оформлен → в работе");
    expect(notificationView({ kind: "order", refId: "x" }, "ru").title).toBe("Новый заказ");
    expect(summarize([{ op: "delete_offers", offerIds: ["a", "b", "c", "d", "e"] }], "ru")).toBe(
      "Удалено позиций: 5",
    );
  });

  it("translates review gaps", () => {
    const model = businessModelSchema.parse({
      profile: { name: "Shop", description: "d", category: null, contacts: {} },
      offer_types: [{ key: "t", name: "T", kind: "product", attributes: [] }],
      offers: [
        {
          title: "A",
          offer_type: "t",
          price: null,
          price_status: "on_request",
          availability: "unknown",
        },
      ],
      policies: {},
      missing_info: [],
    });
    const texts = reviewGaps(model, "ru").map((gap) => gap.text);
    expect(texts).toContain("У 1 позиции нет цены: будет показано «Цена по запросу»");
    expect(texts).toContain("Добавьте телефон, чтобы покупатели могли с вами связаться");
  });

  it("translates known server messages and leaves others alone", () => {
    expect(localizeMessage("ru", "Current password is wrong")).toBe("Текущий пароль неверный");
    expect(localizeMessage("ru", 'Slug "shoes" is taken')).toBe("Адрес «shoes» уже занят");
    expect(localizeMessage("ru", "Change set is already applied")).toBe(
      "Запрос на одобрение уже обработан: применено",
    );
    expect(localizeMessage("ru", "photo.pdf is larger than 20 MB")).toBe(
      "Файл photo.pdf больше 20 МБ",
    );
    expect(localizeMessage("ru", "Something unexpected")).toBe("Something unexpected");
    expect(localizeMessage("en", "Current password is wrong")).toBe("Current password is wrong");
  });

  it("explains a scanned PDF in Russian", () => {
    const message =
      "This PDF has no readable text, it looks like a scan. Upload a text PDF, a CSV or XLSX file, or describe the business by hand.";
    expect(localizeMessage("ru", message)).toContain("скан");
  });

  it("keeps English strings unchanged", () => {
    expect(tr("en", "ib.markReceived")).toBe("Mark received");
    expect(tr("ru", "ib.markReceived")).toBe("Принять заказ");
  });
});
