/**
 * Applies the owner's edits from the review form to a Business Model draft.
 * Open questions that the edits answer are dropped from missing_info.
 */
import { parsePrice } from "@/server/services/onboarding/import";
import {
  availabilitySchema,
  businessModelSchema,
  CONTACT_CHANNELS,
  type BusinessModel,
  type Policies,
} from "@/shared/business-model";
import { CONTACT_FIELDS, POLICY_FIELDS } from "@/shared/labels";
import type { Lang } from "@/server/storefront/i18n";
import { tr, trn, type TextKey } from "@/shared/owner-copy";

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

export function applyReviewEdits(
  original: BusinessModel,
  form: FormData,
  lang: Lang = "en",
): ReviewResult {
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
    errors.push(tr(lang, "rv.errCurrency"));
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
          errors.push(tr(lang, "rv.errPriceNumber", { title: offer.title }));
        } else if (!offerCurrency) {
          errors.push(tr(lang, "rv.errSetCurrency"));
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

export interface ReviewGap {
  id: string;
  text: string;
  /** Element id of the field that fixes it. */
  target: string;
  needed: boolean;
}

const POLICY_GAPS: [keyof Policies, TextKey][] = [
  ["delivery", "gap.policy.delivery"],
  ["payment", "gap.policy.payment"],
  ["returns", "gap.policy.returns"],
  ["working_hours", "gap.policy.working_hours"],
];

const MISSING_KEYS: Record<string, TextKey> = {
  "business name": "rv.miss.name",
  "a description of what the business offers": "rv.miss.description",
  "one contact channel (phone, email, messenger or website)": "rv.miss.contact",
};

export function launchMissingLabel(text: string, lang: Lang = "en"): string {
  const key = MISSING_KEYS[text];
  return key ? tr(lang, key) : text;
}

/** One plain-language item per gap, so the count shown always equals the list length. */
export function reviewGaps(model: BusinessModel, lang: Lang = "en"): ReviewGap[] {
  const gaps: ReviewGap[] = [];
  const { contacts } = model.profile;

  if (model.offers.length === 0) {
    gaps.push({
      id: "offers",
      text: tr(lang, "gap.offers"),
      target: "rv-offers",
      needed: false,
    });
  }
  const unpriced = model.offers.findIndex((o) => o.price === null);
  const noPrice = model.offers.filter((o) => o.price === null).length;
  if (noPrice > 0) {
    gaps.push({
      id: "prices",
      text: trn(lang, "gap.prices", noPrice),
      target: `rv-price-${unpriced}`,
      needed: false,
    });
  }
  const unknown = model.offers.findIndex((o) => o.availability === "unknown");
  const noStock = model.offers.filter((o) => o.availability === "unknown").length;
  if (noStock > 0) {
    gaps.push({
      id: "stock",
      text: trn(lang, "gap.stock", noStock),
      target: `rv-availability-${unknown}`,
      needed: false,
    });
  }
  if (!CONTACT_CHANNELS.some((c) => contacts[c])) {
    gaps.push({
      id: "contact",
      text: tr(lang, "gap.phone"),
      target: "rv-contact-phone",
      needed: true,
    });
  }
  if (!contacts.email) {
    gaps.push({
      id: "email",
      text: tr(lang, "gap.email"),
      target: "rv-contact-email",
      needed: false,
    });
  }
  if (!contacts.address) {
    gaps.push({
      id: "address",
      text: tr(lang, "gap.address"),
      target: "rv-contact-address",
      needed: false,
    });
  }
  for (const [key, textKey] of POLICY_GAPS) {
    if (model.policies[key] === null) {
      gaps.push({
        id: `policy-${key}`,
        text: tr(lang, textKey),
        target: `rv-policy-${key}`,
        needed: false,
      });
    }
  }
  model.missing_info.forEach((item, i) => {
    if (/^(offers|profile\.contacts|policies\.)/.test(item.field)) return;
    gaps.push({
      id: `open-${i}`,
      text: item.question.replace(/\.$/, ""),
      target: "rv-profile",
      needed: item.severity === "blocking",
    });
  });
  return gaps;
}

export interface SourceAssetInfo {
  filename: string;
  kind: string;
  extractedText?: string | null;
}

export interface Provenance {
  offers: (string | null)[];
  policies: Partial<Record<keyof Policies, string>>;
}

const squash = (text: string) => text.replace(/\s+/g, " ").toLowerCase();

/** Which uploaded file each offer and policy text was read from, matched by content. */
export function sourceProvenance(model: BusinessModel, assets: SourceAssetInfo[]): Provenance {
  const texts = assets
    .filter((a) => a.kind !== "note" && a.extractedText)
    .map((a) => ({ filename: a.filename, kind: a.kind, text: squash(a.extractedText ?? "") }));
  const tables = texts.filter((t) => t.kind === "xlsx" || t.kind === "csv");

  const offers = model.offers.map((offer) => {
    const title = squash(offer.title);
    return (
      (tables.find((t) => t.text.includes(title)) ?? texts.find((t) => t.text.includes(title)))
        ?.filename ?? null
    );
  });

  const policies: Provenance["policies"] = {};
  for (const [key] of POLICY_FIELDS) {
    const value = model.policies[key];
    if (!value) continue;
    const parts = value.split(/(?<=[.!?])\s+/).map(squash);
    const hit = texts.find((t) => parts.some((p) => p.length >= 8 && t.text.includes(p)));
    if (hit) policies[key] = hit.filename;
  }
  return { offers, policies };
}
