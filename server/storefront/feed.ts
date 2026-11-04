import type { OfferView } from "@/server/services/catalog";
import type { AttributeValue } from "@/shared/business-model";
import { absoluteImageUrl, offerPath, storePath } from "./seo";

const TITLE_LIMIT = 150;
const DESCRIPTION_LIMIT = 5000;

export interface MerchantFeedInput {
  baseUrl: string;
  slug: string;
  storeName: string;
  storeDescription: string;
  offers: OfferView[];
}

export interface MerchantFeed {
  xml: string;
  included: number;
  skippedNoPrice: number;
  skippedUnknownAvailability: number;
}

export function escapeXml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const clip = (text: string, limit: number) => Array.from(text.trim()).slice(0, limit).join("");

function tag(name: string, value: string): string {
  return `<${name}>${escapeXml(value)}</${name}>`;
}

function text(value: AttributeValue | undefined): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

const GENDER: Record<string, string> = { men: "male", women: "female", unisex: "unisex" };

function itemXml(offer: OfferView, baseUrl: string, slug: string): string | null {
  const price = offer.priceStatus === "confirmed" ? offer.price : null;
  if (price === null || !offer.currency || !Number.isFinite(Number(price))) return null;
  const availability =
    offer.availability === "in_stock"
      ? "in_stock"
      : offer.availability === "out_of_stock"
        ? "out_of_stock"
        : null;
  if (!availability) return null;

  const attrs = offer.attributes as Record<string, AttributeValue>;
  const image = absoluteImageUrl(offer.imageUrl, baseUrl);
  const brand = text(attrs.brand);
  const color = text(attrs.color);
  const gender = text(attrs.gender);
  const lines = [
    tag("g:id", offer.id),
    tag("title", clip(offer.title, TITLE_LIMIT)),
    tag(
      "description",
      clip(offer.description, DESCRIPTION_LIMIT) || clip(offer.title, TITLE_LIMIT),
    ),
    tag("link", `${baseUrl}${offerPath(slug, offer.id)}`),
    ...(image ? [tag("g:image_link", image)] : []),
    tag("g:price", `${Number(price).toFixed(2)} ${offer.currency}`),
    tag("g:availability", availability),
    tag("g:condition", "new"),
    ...(brand ? [tag("g:brand", brand)] : []),
    ...(color ? [tag("g:color", color)] : []),
    ...(gender && GENDER[gender] ? [tag("g:gender", GENDER[gender])] : []),
    ...(gender === "kids" ? [tag("g:age_group", "kids")] : []),
    ...(offer.category ? [tag("g:product_type", offer.category)] : []),
    tag("g:item_group_id", offer.id),
  ];
  return `    <item>\n${lines.map((line) => `      ${line}`).join("\n")}\n    </item>`;
}

/** Google Merchant Center RSS 2.0 feed. Offers without a confirmed price or a known stock state are left out, because the spec requires both. */
export function buildMerchantFeed(input: MerchantFeedInput): MerchantFeed {
  const items: string[] = [];
  let skippedNoPrice = 0;
  let skippedUnknownAvailability = 0;
  for (const offer of input.offers) {
    const priced = offer.priceStatus === "confirmed" && offer.price !== null && !!offer.currency;
    if (!priced) {
      skippedNoPrice += 1;
      continue;
    }
    const xml = itemXml(offer, input.baseUrl, input.slug);
    if (xml) items.push(xml);
    else skippedUnknownAvailability += 1;
  }
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">',
    "  <channel>",
    `    ${tag("title", input.storeName)}`,
    `    ${tag("link", `${input.baseUrl}${storePath(input.slug)}`)}`,
    `    ${tag("description", clip(input.storeDescription, 500) || input.storeName)}`,
    ...items,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
  return { xml, included: items.length, skippedNoPrice, skippedUnknownAvailability };
}
