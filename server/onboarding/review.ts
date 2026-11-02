/**
 * Applies the owner's edits from the review form to a Business Model draft.
 * Open questions that the edits answer are dropped from missing_info.
 */
import { parsePrice } from "@/server/services/onboarding/import";
import {
  availabilitySchema,
  businessModelSchema,
  type BusinessModel,
  type Policies,
} from "@/shared/business-model";
import { CONTACT_FIELDS, POLICY_FIELDS } from "@/shared/labels";

export type ReviewResult = { ok: true; model: BusinessModel } | { ok: false; errors: string[] };

function field(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : undefined;
}

/** Most common currency among priced offers, used for prices the owner adds. */
export function primaryCurrency(model: BusinessModel): string | null {
  const counts = new Map<string, number>();
  for (const offer of model.offers) {
    if (offer.currency) counts.set(offer.currency, (counts.get(offer.currency) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

export function applyReviewEdits(original: BusinessModel, form: FormData): ReviewResult {
  const model: BusinessModel = structuredClone(original);
  const errors: string[] = [];

  const name = field(form, "profile.name");
  if (name !== undefined) model.profile.name = name;
  const description = field(form, "profile.description");
  if (description !== undefined) model.profile.description = description;
  const category = field(form, "profile.category");
  if (category !== undefined) model.profile.category = category || null;

  for (const [key] of CONTACT_FIELDS) {
    const value = field(form, `contact.${key}`);
    if (value === undefined) continue;
    if (value === "") delete model.profile.contacts[key];
    else model.profile.contacts[key] = value;
  }

  for (const [key] of POLICY_FIELDS) {
    const value = field(form, `policy.${key}`);
    if (value !== undefined) model.policies[key] = value || null;
  }

  const currencyInput = field(form, "currency")?.toUpperCase();
  if (currencyInput && !/^[A-Z]{3}$/.test(currencyInput)) {
    errors.push("Currency must be a three-letter code such as KZT or USD.");
  }
  const currency = currencyInput && /^[A-Z]{3}$/.test(currencyInput) ? currencyInput : null;

  model.offers.forEach((offer, i) => {
    const priceText = field(form, `offer.${i}.price`);
    if (priceText !== undefined) {
      if (priceText === "") {
        offer.price = null;
        offer.price_status = "on_request";
      } else {
        const price = parsePrice(priceText);
        const offerCurrency = offer.currency ?? currency;
        if (price === null) {
          errors.push(`"${offer.title}": the price is not a number.`);
        } else if (!offerCurrency) {
          errors.push("Set the currency for the prices you added.");
        } else {
          offer.price = price;
          offer.currency = offerCurrency;
          offer.price_status = "confirmed";
        }
      }
    }
    const availability = availabilitySchema.safeParse(field(form, `offer.${i}.availability`));
    if (availability.success) offer.availability = availability.data;
  });

  const hasContact = Object.values(model.profile.contacts).some((v) => v && v.trim() !== "");
  const allPriced = model.offers.every((o) => o.price !== null);
  model.missing_info = model.missing_info.filter((item) => {
    const [root, sub] = item.field.split(".");
    if (root === "policies" && sub && sub in model.policies) {
      return model.policies[sub as keyof Policies] === null;
    }
    if (item.field.startsWith("profile.contacts")) return !hasContact;
    if (item.field === "offers.price" || item.field === "offers.currency") return !allPriced;
    if (item.field === "offers") return model.offers.length === 0;
    return true;
  });

  if (errors.length > 0) return { ok: false, errors: [...new Set(errors)] };
  const parsed = businessModelSchema.safeParse(model);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "model"}: ${issue.message}`),
    };
  }
  return { ok: true, model: parsed.data };
}
