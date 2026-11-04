import {
  groupAvailability,
  groupPrice,
  groupSizes,
  sizeOf,
  type OfferGroup,
  type OfferView,
} from "@/server/services/catalog";
import type { Inquiry, Order } from "@/server/services/orders";
import type { Policies } from "@/shared/business-model";

const AVAILABILITY_LABEL = {
  in_stock: "In stock",
  out_of_stock: "Out of stock",
  unknown: "Availability to be confirmed",
} as const;

export function formatMoney(amount: number, currency: string): string {
  const value = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(amount);
  return `${value} ${currency}`;
}

export function priceLabel(offer: Pick<OfferView, "price" | "currency" | "priceStatus">): string {
  return offer.priceStatus === "confirmed" && offer.price !== null && offer.currency
    ? formatMoney(offer.price, offer.currency)
    : "Price on request";
}

/** What a shopper (or their agent) may see about an offer. */
export function publicOffer(offer: OfferView) {
  const orderable =
    offer.priceStatus === "confirmed" &&
    offer.availability === "in_stock" &&
    offer.status === "active";
  return {
    offer_id: offer.id,
    title: offer.title,
    description: offer.description,
    category: offer.category,
    model: offer.model,
    type: offer.offerTypeName,
    attributes: offer.attributes,
    image_url: offer.imageUrl,
    price: offer.priceStatus === "confirmed" ? offer.price : null,
    currency: offer.priceStatus === "confirmed" ? offer.currency : null,
    price_status: offer.priceStatus,
    price_on_request: offer.priceStatus !== "confirmed",
    price_label: priceLabel(offer),
    availability: offer.availability,
    availability_label: AVAILABILITY_LABEL[offer.availability],
    /** False means the shopper should send an inquiry instead of ordering. */
    can_order: orderable,
  };
}

/** Owner view: everything, including status and identifiers. */
export function ownerOffer(offer: OfferView) {
  return {
    ...publicOffer(offer),
    offer_type_key: offer.offerTypeKey,
    status: offer.status,
    updated_at: offer.updatedAt.toISOString(),
  };
}

export function policiesWithStates(policies: Policies) {
  const states: Record<string, string> = {};
  for (const [key, value] of Object.entries(policies)) {
    if (key === "other" && value === null) continue;
    states[key] = value ?? "To be confirmed";
  }
  return states;
}

export function orderView(order: Order) {
  return {
    order_id: order.id,
    status: order.status,
    source: order.source,
    items: order.items,
    total: order.total,
    currency: order.currency,
    total_label:
      order.total !== null && order.currency ? formatMoney(order.total, order.currency) : null,
    contact: order.contact,
    conversation_id: order.conversationId,
    created_at: order.createdAt.toISOString(),
    submitted_at: order.submittedAt?.toISOString() ?? null,
  };
}

export function inquiryView(inquiry: Inquiry) {
  return {
    inquiry_id: inquiry.id,
    status: inquiry.status,
    subject: inquiry.subject,
    details: inquiry.details,
    contact: inquiry.contact,
    conversation_id: inquiry.conversationId,
    created_at: inquiry.createdAt.toISOString(),
  };
}

/**
 * A product card for shoppers: one row per model. The row keeps the shape of a
 * single offer, with `sizes` listing the sizes in stock and `variants` the
 * concrete per-size offers. Offers without a model are shown as they are.
 */
export function publicGroup(group: OfferGroup) {
  return group.model === null
    ? publicOffer(group.lead)
    : publicModel({ ...group, model: group.model });
}

export function publicModel(group: OfferGroup & { model: string }) {
  const base = publicOffer(group.lead);
  const price = groupPrice(group);
  const availability = groupAvailability(group);
  const { available, unavailable, unknown } = groupSizes(group);
  const attributes = Object.fromEntries(
    Object.entries(group.lead.attributes as Record<string, unknown>).filter(
      ([key]) => key !== "size",
    ),
  );
  const range =
    price && price.min !== price.max
      ? `${formatMoney(price.min, price.currency)} - ${formatMoney(price.max, price.currency)}`
      : price
        ? formatMoney(price.min, price.currency)
        : "Price on request";
  const orderable = group.variants.some(
    (v) => v.priceStatus === "confirmed" && v.availability === "in_stock",
  );
  const withSizes = available.length + unavailable.length + unknown.length > 0;
  return {
    ...base,
    title: group.model,
    attributes: withSizes ? { ...attributes, sizes: available } : attributes,
    price: price?.min ?? null,
    price_max: price && price.max !== price.min ? price.max : null,
    currency: price?.currency ?? null,
    price_status: price ? ("confirmed" as const) : ("on_request" as const),
    price_on_request: price === null,
    price_label: range,
    image_url: group.lead.imageUrl ?? group.variants.find((v) => v.imageUrl)?.imageUrl ?? null,
    availability,
    availability_label: AVAILABILITY_LABEL[availability],
    can_order: orderable,
    sizes: available,
    unavailable_sizes: unavailable,
    unknown_sizes: unknown,
    variants: group.variants.map((v) => ({
      offer_id: v.id,
      title: v.title,
      size: sizeOf(v),
      availability: v.availability,
      availability_label: AVAILABILITY_LABEL[v.availability],
      price_label: priceLabel(v),
      can_order:
        v.priceStatus === "confirmed" && v.availability === "in_stock" && v.status === "active",
    })),
  };
}

/** Compact row for result lists: sizes in stock mapped to the offer id of that size. */
export function listGroup(group: OfferGroup) {
  if (group.model === null) return publicOffer(group.lead);
  const { variants, ...row } = publicModel({ ...group, model: group.model });
  return {
    ...row,
    variant_ids: Object.fromEntries(
      variants.flatMap((v) => (v.size && v.can_order ? [[v.size, v.offer_id]] : [])),
    ),
  };
}
