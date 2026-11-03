import type { Contacts } from "@/shared/business-model";

export const DESCRIPTION_LIMIT = 160;

export type Availability = "in_stock" | "out_of_stock" | "unknown";

export function trimDescription(text: string, limit = DESCRIPTION_LIMIT): string | undefined {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  const chars = Array.from(clean);
  if (chars.length <= limit) return clean;
  const cut = chars.slice(0, limit - 1).join("");
  const space = cut.lastIndexOf(" ");
  const base = space > limit / 2 ? cut.slice(0, space) : cut;
  return `${base.replace(/[\s.,;:!-]+$/, "")}…`;
}

export function storePath(slug: string): string {
  return `/s/${slug}`;
}

export function offerPath(slug: string, offerId: string): string {
  return `/s/${slug}/offers/${offerId}`;
}

/** Absolute https or same-origin image URL, or undefined. */
export function absoluteImageUrl(
  url: string | null | undefined,
  baseUrl: string,
): string | undefined {
  if (!url) return undefined;
  if (/^https:\/\//i.test(url)) return url;
  if (/^\/(?!\/)/.test(url)) return `${baseUrl}${url}`;
  if (/^http:\/\//i.test(url)) {
    try {
      return new URL(url).origin === new URL(baseUrl).origin ? url : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface PageMetaInput {
  title: string;
  description?: string;
  path: string;
  baseUrl: string;
  image?: string | null;
  siteName?: string;
}

export interface PageMeta {
  title: string;
  description?: string;
  alternates: { canonical: string };
  openGraph: {
    type: "website";
    title: string;
    description?: string;
    url: string;
    siteName?: string;
    images?: { url: string }[];
  };
  twitter: {
    card: "summary" | "summary_large_image";
    title: string;
    description?: string;
    images?: string[];
  };
}

export function buildPageMeta(input: PageMetaInput): PageMeta {
  const url = `${input.baseUrl}${input.path}`;
  const description = input.description ? trimDescription(input.description) : undefined;
  const image = absoluteImageUrl(input.image, input.baseUrl);
  return {
    title: input.title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "website",
      title: input.title,
      description,
      url,
      siteName: input.siteName,
      images: image ? [{ url: image }] : undefined,
    },
    twitter: {
      card: image ? "summary_large_image" : "summary",
      title: input.title,
      description,
      images: image ? [image] : undefined,
    },
  };
}

const SCHEMA_AVAILABILITY: Record<Availability, string | null> = {
  in_stock: "https://schema.org/InStock",
  out_of_stock: "https://schema.org/OutOfStock",
  unknown: null,
};

export interface ProductLdInput {
  name: string;
  description?: string;
  url: string;
  image?: string;
  category?: string | null;
  price: number | null;
  currency: string | null;
  availability: Availability;
}

/** Null unless the price is known. */
export function productJsonLd(input: ProductLdInput): Record<string, unknown> | null {
  if (input.price === null || !input.currency || !Number.isFinite(input.price)) return null;
  const availability = SCHEMA_AVAILABILITY[input.availability];
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: input.name,
    ...(input.description ? { description: trimDescription(input.description, 500) } : {}),
    ...(input.image ? { image: input.image } : {}),
    ...(input.category ? { category: input.category } : {}),
    url: input.url,
    offers: {
      "@type": "Offer",
      price: input.price,
      priceCurrency: input.currency,
      url: input.url,
      ...(availability ? { availability } : {}),
    },
  };
}

export interface StoreLdInput {
  name: string;
  description?: string;
  url: string;
  image?: string;
  contacts: Contacts;
}

export function storeJsonLd(input: StoreLdInput): Record<string, unknown> {
  const c = input.contacts;
  const sameAs = [c.website, c.instagram].filter(
    (v): v is string => !!v && /^https?:\/\//i.test(v),
  );
  return {
    "@context": "https://schema.org",
    "@type": "Store",
    name: input.name,
    url: input.url,
    ...(input.description ? { description: trimDescription(input.description, 500) } : {}),
    ...(input.image ? { image: input.image } : {}),
    ...(c.phone ? { telephone: c.phone } : {}),
    ...(c.email ? { email: c.email } : {}),
    ...(c.address ? { address: c.address } : {}),
    ...(sameAs.length > 0 ? { sameAs } : {}),
  };
}

export function jsonLdString(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export const SITEMAP_MAX_STORES = 200;
export const SITEMAP_OFFERS_PER_STORE = 100;
export const SITEMAP_MAX_URLS = 5000;

export const ROBOTS_DISALLOW = ["/app", "/onboarding", "/signin", "/api", "/mcp", "/s/*/orders/"];
