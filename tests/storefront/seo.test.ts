import { describe, expect, it } from "vitest";
import {
  absoluteImageUrl,
  buildPageMeta,
  jsonLdString,
  productJsonLd,
  storeJsonLd,
  trimDescription,
} from "@/server/storefront/seo";

const base = "https://shop.example";

type Ld = { offers: Record<string, unknown> };

describe("storefront seo", () => {
  it("trims descriptions on word boundaries", () => {
    expect(trimDescription("  ")).toBeUndefined();
    expect(trimDescription("a  b\nc")).toBe("a b c");
    const out = trimDescription("word ".repeat(100))!;
    expect(Array.from(out).length).toBeLessThanOrEqual(160);
    expect(out.endsWith("\u2026")).toBe(true);
  });

  it("accepts only https or same-origin images", () => {
    expect(absoluteImageUrl("https://cdn.x/a.jpg", base)).toBe("https://cdn.x/a.jpg");
    expect(absoluteImageUrl("/img/a.jpg", base)).toBe("https://shop.example/img/a.jpg");
    expect(absoluteImageUrl("//evil.x/a.jpg", base)).toBeUndefined();
    expect(absoluteImageUrl("http://other.x/a.jpg", base)).toBeUndefined();
    expect(absoluteImageUrl("http://localhost:3000/a.jpg", "http://localhost:3000")).toBe(
      "http://localhost:3000/a.jpg",
    );
    expect(absoluteImageUrl("javascript:alert(1)", base)).toBeUndefined();
    expect(absoluteImageUrl(null, base)).toBeUndefined();
  });

  it("builds canonical, open graph and twitter metadata", () => {
    const plain = buildPageMeta({ title: "T", description: "D", path: "/s/a", baseUrl: base });
    expect(plain.alternates.canonical).toBe("https://shop.example/s/a");
    expect(plain.openGraph.images).toBeUndefined();
    expect(plain.twitter.card).toBe("summary");

    const withImage = buildPageMeta({ title: "T", path: "/s/a", baseUrl: base, image: "/i.png" });
    expect(withImage.openGraph.images).toEqual([{ url: "https://shop.example/i.png" }]);
    expect(withImage.twitter.card).toBe("summary_large_image");
  });

  it("emits product JSON-LD only with a known price", () => {
    const input = {
      name: "Shoe",
      url: "https://shop.example/s/a/offers/1",
      price: 49.5,
      currency: "USD",
      availability: "in_stock" as const,
    };
    const ld = productJsonLd(input) as Ld;
    expect(ld.offers).toMatchObject({
      price: 49.5,
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
    });
    expect(productJsonLd({ ...input, price: null, currency: null })).toBeNull();
    const unknown = productJsonLd({ ...input, availability: "unknown" }) as Ld;
    expect(unknown.offers).not.toHaveProperty("availability");
    const out = productJsonLd({ ...input, availability: "out_of_stock" }) as Ld;
    expect(out.offers.availability).toBe("https://schema.org/OutOfStock");
  });

  it("emits store JSON-LD with contacts and escapes markup", () => {
    const ld = storeJsonLd({
      name: "</script>Shop",
      url: base,
      contacts: { phone: "+1", email: "a@b.co", address: "1 Main", website: "https://x.y" },
    });
    expect(ld).toMatchObject({ "@type": "Store", telephone: "+1", sameAs: ["https://x.y"] });
    const text = jsonLdString(ld);
    expect(text).not.toContain("<");
    expect(JSON.parse(text).name).toBe("</script>Shop");
  });
});
