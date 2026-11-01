import type { OfferView } from "@/server/services/catalog";
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
    type: offer.offerTypeName,
    attributes: offer.attributes,
    price: offer.priceStatus === "confirmed" ? offer.price : null,
    currency: offer.priceStatus === "confirmed" ? offer.currency : null,
    price_status: offer.priceStatus,
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
