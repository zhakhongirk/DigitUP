import { describe, expect, it } from "vitest";
import { applyReviewEdits, primaryCurrency } from "@/server/onboarding/review";
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
