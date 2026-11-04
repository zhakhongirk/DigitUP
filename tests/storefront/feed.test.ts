import { describe, expect, it } from "vitest";
import type { OfferView } from "@/server/services/catalog";
import { buildMerchantFeed, escapeXml } from "@/server/storefront/feed";

const base = "https://shop.example.com";

function offer(over: Partial<OfferView> = {}): OfferView {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Air Runner",
    description: "Light running shoe",
    category: "Running",
    offerTypeKey: "shoes",
    offerTypeName: "Shoes",
    attributes: { brand: "Nike", color: "black", gender: "men", sizes: ["41", "42"] },
    imageUrl: "/demo/running.svg",
    price: "45000",
    currency: "KZT",
    priceStatus: "confirmed",
    availability: "in_stock",
    status: "active",
    ...over,
  } as unknown as OfferView;
}

function feed(offers: OfferView[], name = "Stride Shoes") {
  return buildMerchantFeed({
    baseUrl: base,
    slug: "stride-shoes",
    storeName: name,
    storeDescription: "Shoes",
    offers,
  });
}

/** Checks that tags nest correctly; enough to catch broken escaping. */
function wellFormed(xml: string): boolean {
  const body = xml.replace(/<\?xml[^>]*\?>/, "");
  const stack: string[] = [];
  for (const match of body.matchAll(/<(\/?)([A-Za-z][\w:.-]*)[^<>]*?(\/?)>/g)) {
    const [, closing, name, selfClosing] = match;
    if (selfClosing) continue;
    if (closing) {
      if (stack.pop() !== name) return false;
    } else stack.push(name!);
  }
  const stripped = body.replace(/<[^<>]*>/g, "");
  return (
    stack.length === 0 && !/[<>]/.test(stripped) && !/&(?!(amp|lt|gt|quot|apos);)/.test(stripped)
  );
}

describe("buildMerchantFeed", () => {
  it("writes an RSS 2.0 item with the Google fields", () => {
    const result = feed([offer()]);
    expect(result.included).toBe(1);
    expect(wellFormed(result.xml)).toBe(true);
    expect(result.xml).toContain('<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">');
    for (const part of [
      "<g:id>11111111-1111-4111-8111-111111111111</g:id>",
      "<title>Air Runner</title>",
      "<description>Light running shoe</description>",
      `<link>${base}/s/stride-shoes/offers/11111111-1111-4111-8111-111111111111</link>`,
      `<g:image_link>${base}/demo/running.svg</g:image_link>`,
      "<g:price>45000.00 KZT</g:price>",
      "<g:availability>in_stock</g:availability>",
      "<g:condition>new</g:condition>",
      "<g:brand>Nike</g:brand>",
      "<g:gender>male</g:gender>",
      "<g:item_group_id>11111111-1111-4111-8111-111111111111</g:item_group_id>",
    ]) {
      expect(result.xml).toContain(part);
    }
    expect(result.xml).toContain(`<link>${base}/s/stride-shoes</link>`);
  });

  it("skips offers without a confirmed price or a known stock state and counts them", () => {
    const result = feed([
      offer(),
      offer({ id: "a", priceStatus: "on_request", price: null, currency: null }),
      offer({ id: "b", availability: "unknown" }),
      offer({ id: "c", availability: "out_of_stock" }),
    ]);
    expect(result.included).toBe(2);
    expect(result.skippedNoPrice).toBe(1);
    expect(result.skippedUnknownAvailability).toBe(1);
    expect(result.xml).toContain("<g:availability>out_of_stock</g:availability>");
    expect(result.xml).not.toContain("<g:id>a</g:id>");
    expect(result.xml).not.toContain("<g:id>b</g:id>");
  });

  it("keeps an item without a photo and leaves the image out", () => {
    const result = feed([offer({ imageUrl: null })]);
    expect(result.included).toBe(1);
    expect(result.xml).not.toContain("g:image_link");
  });

  it("escapes markup and drops invalid control characters", () => {
    const result = feed(
      [
        offer({
          title: 'Boots <"Tom & Jerry">',
          description: "It's \u0001 a <b>test</b> & more",
          attributes: { brand: "A&B" },
        }),
      ],
      "Tom & <Co>",
    );
    expect(wellFormed(result.xml)).toBe(true);
    expect(result.xml).toContain("<title>Boots &lt;&quot;Tom &amp; Jerry&quot;&gt;</title>");
    expect(result.xml).toContain("It&apos;s  a &lt;b&gt;test&lt;/b&gt; &amp; more");
    expect(result.xml).toContain("<g:brand>A&amp;B</g:brand>");
    expect(result.xml).toContain("<title>Tom &amp; &lt;Co&gt;</title>");
  });

  it("uses the title when the description is empty and never writes an em dash", () => {
    const result = feed([offer({ description: "" })]);
    expect(result.xml).toContain("<description>Air Runner</description>");
    expect(result.xml).not.toContain(String.fromCharCode(0x2014));
  });

  it("produces an empty channel for an empty catalog", () => {
    const result = feed([]);
    expect(result.included).toBe(0);
    expect(wellFormed(result.xml)).toBe(true);
    expect(result.xml).not.toContain("<item>");
  });
});

describe("escapeXml", () => {
  it("escapes the five special characters", () => {
    expect(escapeXml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&apos;");
  });
});
