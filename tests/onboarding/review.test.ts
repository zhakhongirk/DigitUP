import { describe, expect, it } from "vitest";
import {
  applyReviewEdits,
  primaryCurrency,
  reviewGaps,
  sourceProvenance,
} from "@/server/onboarding/review";
import { businessModelSchema, type BusinessModel } from "@/shared/business-model";

function model(): BusinessModel {
  return businessModelSchema.parse({
    profile: { name: "Fade Factory", description: "Barbershop", contacts: {} },
    offer_types: [{ key: "service", name: "Services", kind: "service", attributes: [] }],
    offers: [
      {
        title: "Haircut",
        offer_type: "service",
        price: 8000,
        currency: "KZT",
        price_status: "confirmed",
      },
      { title: "Wedding styling", offer_type: "service", price_status: "on_request" },
    ],
    missing_info: [
      { field: "profile.contacts", question: "How can customers reach you?", severity: "blocking" },
      { field: "policies.payment", question: "Which payment methods?" },
      { field: "offers.price", question: "1 offer has no price." },
    ],
  });
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

describe("applyReviewEdits", () => {
  it("applies profile, contact and policy edits and closes answered questions", () => {
    const result = applyReviewEdits(
      model(),
      form({
        "profile.name": " Fade Factory Almaty ",
        "contact.phone": "+7 701 000 00 00",
        "contact.email": "",
        "policy.payment": "Cash or Kaspi",
        "policy.delivery": "",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.profile.name).toBe("Fade Factory Almaty");
    expect(result.model.profile.contacts).toEqual({ phone: "+7 701 000 00 00" });
    expect(result.model.policies.payment).toBe("Cash or Kaspi");
    expect(result.model.policies.delivery).toBeNull();
    expect(result.model.missing_info.map((m) => m.field)).toEqual(["offers.price"]);
  });

  it("sets prices with the review currency and clears them to on request", () => {
    const result = applyReviewEdits(
      model(),
      form({
        currency: "kzt",
        "offer.0.price": "",
        "offer.1.price": "25 000",
        "offer.1.availability": "in_stock",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [haircut, wedding] = result.model.offers;
    expect(haircut).toMatchObject({ price: null, price_status: "on_request" });
    expect(wedding).toMatchObject({
      price: 25000,
      currency: "KZT",
      price_status: "confirmed",
      availability: "in_stock",
    });
  });

  it("rejects prices without a currency and prices that are not numbers", () => {
    const noCurrency = businessModelSchema.parse({
      ...model(),
      offers: [{ title: "Beard", offer_type: "service", price_status: "on_request" }],
    });
    const missing = applyReviewEdits(noCurrency, form({ "offer.0.price": "5000" }));
    expect(missing).toEqual({ ok: false, errors: ["Set the currency for the prices you added."] });

    const bad = applyReviewEdits(model(), form({ "offer.1.price": "ask us" }));
    expect(bad.ok).toBe(false);

    const badCurrency = applyReviewEdits(model(), form({ currency: "tenge" }));
    expect(badCurrency.ok).toBe(false);
  });

  it("does not modify the original model", () => {
    const original = model();
    const snapshot = structuredClone(original);
    applyReviewEdits(original, form({ "profile.name": "Other", "offer.0.price": "1" }));
    expect(original).toEqual(snapshot);
  });

  it("picks the most common currency", () => {
    expect(primaryCurrency(model())).toBe("KZT");
    expect(primaryCurrency({ ...model(), offers: [] })).toBeNull();
  });
});

describe("reviewGaps", () => {
  it("lists one plain-language item per gap", () => {
    const gaps = reviewGaps(model());
    const text = gaps.map((g) => g.text);
    expect(text).toContain("Add your phone number so customers can reach you");
    expect(text).toContain("1 offer has no price: it will show 'Price on request'");
    expect(text).toContain("2 offers have no stock status: they will show 'To be confirmed'");
    expect(gaps.find((g) => g.id === "contact")?.needed).toBe(true);
    expect(new Set(gaps.map((g) => g.id)).size).toBe(gaps.length);
  });

  it("is empty when nothing is missing", () => {
    const full = businessModelSchema.parse({
      profile: {
        name: "A",
        contacts: { phone: "1", email: "a@b.co", address: "Main 1" },
      },
      offer_types: [{ key: "p", name: "P", kind: "product", attributes: [] }],
      offers: [
        {
          title: "Cap",
          offer_type: "p",
          price: 5,
          currency: "KZT",
          price_status: "confirmed",
          availability: "in_stock",
        },
      ],
      policies: { delivery: "d", payment: "p", returns: "r", working_hours: "w" },
    });
    expect(reviewGaps(full)).toEqual([]);
  });
});

describe("sourceProvenance", () => {
  it("names the file an offer or policy was read from", () => {
    const m = model();
    m.policies.payment = "Pay by card or cash.";
    const result = sourceProvenance(m, [
      { filename: "terms.pdf", kind: "pdf", extractedText: "We accept it.\nPay by  card or cash." },
      { filename: "prices.xlsx", kind: "xlsx", extractedText: "Haircut | 8000" },
    ]);
    expect(result.offers).toEqual(["prices.xlsx", null]);
    expect(result.policies.payment).toBe("terms.pdf");
  });
});
