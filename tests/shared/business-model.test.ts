import { describe, expect, it } from "vitest";
import {
  offerSchema,
  businessModelSchema,
  checkLaunchReadiness,
  contactsSchema,
  offerAttributeIssues,
  type BusinessModelInput,
  type OfferType,
} from "@/shared/business-model";

const shoeType = {
  key: "shoes",
  name: "Shoes",
  kind: "product" as const,
  attributes: [
    { key: "brand", label: "Brand", type: "text" as const },
    { key: "season", label: "Season", type: "enum" as const, options: ["summer", "winter"] },
    { key: "sizes", label: "Sizes", type: "list" as const, options: ["40", "41", "42"] },
    { key: "weight", label: "Weight", type: "number" as const, unit: "g" },
    { key: "waterproof", label: "Waterproof", type: "boolean" as const },
  ],
};

function baseModel(overrides: Partial<BusinessModelInput> = {}): BusinessModelInput {
  return {
    profile: { name: "Shoe Shop" },
    offer_types: [shoeType],
    offers: [
      {
        title: "Runner",
        offer_type: "shoes",
        price_status: "confirmed",
        price: 100,
        currency: "USD",
      },
    ],
    ...overrides,
  };
}

function issueMessages(input: unknown): { path: string; message: string }[] {
  const result = businessModelSchema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

describe("businessModelSchema", () => {
  it("parses a minimal model and applies defaults", () => {
    const model = businessModelSchema.parse({ profile: { name: "Tiny" } });
    expect(model.profile).toEqual({ name: "Tiny", description: "", category: null, contacts: {} });
    expect(model.offer_types).toEqual([]);
    expect(model.offers).toEqual([]);
    expect(model.missing_info).toEqual([]);
    expect(model.policies).toEqual({
      delivery: null,
      payment: null,
      returns: null,
      working_hours: null,
      other: null,
    });
  });

  it("applies offer defaults", () => {
    const model = businessModelSchema.parse(baseModel());
    const offer = model.offers[0]!;
    expect(offer.description).toBe("");
    expect(offer.category).toBeNull();
    expect(offer.attributes).toEqual({});
    expect(offer.availability).toBe("unknown");
    expect(offer.status).toBe("active");
  });

  it("rejects an offer referencing an unknown offer type", () => {
    const issues = issueMessages(
      baseModel({
        offers: [{ title: "X", offer_type: "ghost", price_status: "on_request" }],
      }),
    );
    expect(issues).toContainEqual({
      path: "offers.0.offer_type",
      message: expect.stringContaining("unknown offer type"),
    });
  });

  it("rejects an enum value outside its options", () => {
    const issues = issueMessages(
      baseModel({
        offers: [
          {
            title: "X",
            offer_type: "shoes",
            price_status: "on_request",
            attributes: { season: "spring" },
          },
        ],
      }),
    );
    expect(issues.map((i) => i.path)).toContain("offers.0.attributes.season");
  });

  it("rejects a list value outside its options", () => {
    const issues = issueMessages(
      baseModel({
        offers: [
          {
            title: "X",
            offer_type: "shoes",
            price_status: "on_request",
            attributes: { sizes: ["41", "99"] },
          },
        ],
      }),
    );
    expect(issues).toContainEqual({
      path: "offers.0.attributes.sizes",
      message: expect.stringContaining("99"),
    });
  });

  it("rejects an enum attribute without options", () => {
    const issues = issueMessages(
      baseModel({
        offer_types: [
          {
            key: "t",
            name: "T",
            kind: "other",
            attributes: [{ key: "a", label: "A", type: "enum" }],
          },
        ],
        offers: [],
      }),
    );
    expect(issues.length).toBeGreaterThan(0);
  });

  it("rejects a confirmed price with a null price", () => {
    const issues = issueMessages(
      baseModel({
        offers: [{ title: "X", offer_type: "shoes", price_status: "confirmed", price: null }],
      }),
    );
    expect(issues.map((i) => i.path)).toContain("offers.0.price");
  });

  it("rejects a price without a currency", () => {
    const issues = issueMessages(
      baseModel({
        offers: [{ title: "X", offer_type: "shoes", price_status: "confirmed", price: 10 }],
      }),
    );
    expect(issues.map((i) => i.path)).toContain("offers.0.currency");
  });

  it("accepts on_request with no price and no currency", () => {
    const result = businessModelSchema.safeParse(
      baseModel({ offers: [{ title: "X", offer_type: "shoes", price_status: "on_request" }] }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects duplicate offer type keys", () => {
    const issues = issueMessages(
      baseModel({ offer_types: [shoeType, { ...shoeType, name: "Dup" }] }),
    );
    expect(issues).toContainEqual({
      path: "offer_types.1.key",
      message: expect.stringContaining("duplicate offer type key"),
    });
  });

  it("rejects duplicate attribute keys within a type", () => {
    const issues = issueMessages(
      baseModel({
        offer_types: [
          {
            ...shoeType,
            attributes: [
              { key: "brand", label: "Brand", type: "text" },
              { key: "brand", label: "Brand 2", type: "text" },
            ],
          },
        ],
      }),
    );
    expect(issues).toContainEqual({
      path: "offer_types.0.attributes.1.key",
      message: expect.stringContaining("duplicate attribute key"),
    });
  });

  it("rejects an attribute not defined on the offer type", () => {
    const issues = issueMessages(
      baseModel({
        offers: [
          {
            title: "X",
            offer_type: "shoes",
            price_status: "on_request",
            attributes: { colour: "red" },
          },
        ],
      }),
    );
    expect(issues).toContainEqual({
      path: "offers.0.attributes.colour",
      message: expect.stringContaining("not defined"),
    });
  });

  it("rejects non lower_snake_case keys and bad currency codes", () => {
    expect(
      issueMessages(baseModel({ offer_types: [{ ...shoeType, key: "Shoes" }], offers: [] })).length,
    ).toBeGreaterThan(0);
    expect(
      issueMessages(
        baseModel({
          offers: [
            {
              title: "X",
              offer_type: "shoes",
              price_status: "confirmed",
              price: 1,
              currency: "usd",
            },
          ],
        }),
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe("offerAttributeIssues", () => {
  const type: Pick<OfferType, "key" | "attributes"> = {
    key: shoeType.key,
    attributes: shoeType.attributes.map((a) => ({ required: false, ...a })),
  };

  it("returns no issues for valid values", () => {
    expect(
      offerAttributeIssues(
        { brand: "Nike", season: "summer", sizes: ["40", "42"], weight: 300, waterproof: true },
        type,
      ),
    ).toEqual([]);
  });

  it("flags type mismatches per key", () => {
    const issues = offerAttributeIssues(
      { brand: 5, weight: "heavy", waterproof: "yes", season: 1, sizes: "42" },
      type,
    );
    expect(issues.map((i) => i.key).sort()).toEqual([
      "brand",
      "season",
      "sizes",
      "waterproof",
      "weight",
    ]);
  });

  it("flags unknown keys and bad enum/list values", () => {
    const issues = offerAttributeIssues({ colour: "red", season: "spring", sizes: ["43"] }, type);
    expect(issues.map((i) => i.key).sort()).toEqual(["colour", "season", "sizes"]);
    expect(issues.find((i) => i.key === "colour")?.message).toContain('"shoes"');
  });

  it("accepts a list with no declared options", () => {
    const free: Pick<OfferType, "key" | "attributes"> = {
      key: "t",
      attributes: [{ key: "tags", label: "Tags", type: "list", required: false }],
    };
    expect(offerAttributeIssues({ tags: ["a", "b"] }, free)).toEqual([]);
  });
});

describe("checkLaunchReadiness", () => {
  const parse = (input: BusinessModelInput) => businessModelSchema.parse(input);

  it("is ready with name, description and one contact", () => {
    const model = parse({
      profile: { name: "Shop", description: "We sell shoes", contacts: { phone: "+7 700 000" } },
    });
    expect(checkLaunchReadiness(model)).toEqual({ ready: true, missing: [] });
  });

  it("is not ready without a contact channel", () => {
    const result = checkLaunchReadiness(
      parse({ profile: { name: "Shop", description: "We sell shoes" } }),
    );
    expect(result.ready).toBe(false);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]).toContain("contact");
  });

  it("accepts an active offer in place of a description", () => {
    const model = parse({
      ...baseModel(),
      profile: { name: "Shop", contacts: { email: "a@b.co" } },
    });
    expect(checkLaunchReadiness(model).ready).toBe(true);
  });

  it("does not accept only archived or draft offers instead of a description", () => {
    const model = parse({
      ...baseModel({
        offers: [
          { title: "A", offer_type: "shoes", price_status: "on_request", status: "archived" },
          { title: "B", offer_type: "shoes", price_status: "on_request", status: "draft" },
        ],
      }),
      profile: { name: "Shop", contacts: { email: "a@b.co" } },
    });
    const result = checkLaunchReadiness(model);
    expect(result.ready).toBe(false);
    expect(result.missing.join(" ")).toContain("description");
  });

  it("does not count an address as a contact channel", () => {
    const model = parse({
      profile: { name: "Shop", description: "We sell shoes", contacts: { address: "Main st 1" } },
    });
    const result = checkLaunchReadiness(model);
    expect(result.ready).toBe(false);
    expect(result.missing.join(" ")).toContain("contact");
  });

  it("reports everything missing for an empty model", () => {
    const result = checkLaunchReadiness(parse({ profile: { name: "   " } }));
    expect(result.ready).toBe(false);
    expect(result.missing).toHaveLength(3);
  });
});

describe("offer image_url", () => {
  const base = {
    title: "Boot",
    offer_type: "shoes",
    price: null,
    price_status: "on_request" as const,
  };

  it("accepts https URLs and site paths", () => {
    expect(offerSchema.parse({ ...base, image_url: "/demo/boot.jpg" }).image_url).toBe(
      "/demo/boot.jpg",
    );
    expect(
      offerSchema.parse({ ...base, image_url: "https://cdn.example.com/b.jpg" }).image_url,
    ).toBe("https://cdn.example.com/b.jpg");
    expect(offerSchema.parse(base).image_url).toBeNull();
  });

  it("rejects other schemes and malformed values", () => {
    for (const value of [
      "http://example.com/b.jpg",
      "javascript:alert(1)",
      "demo/b.jpg",
      "/a b.jpg",
    ]) {
      expect(offerSchema.safeParse({ ...base, image_url: value }).success).toBe(false);
    }
  });
});

describe("offer image_url protocol-relative paths", () => {
  it("rejects //host paths that browsers resolve as external URLs", () => {
    const base = { title: "Boot", offer_type: "shoes", price_status: "on_request" as const };
    expect(offerSchema.safeParse({ ...base, image_url: "//evil.com/x.png" }).success).toBe(false);
  });
});

describe("contacts.kaspi", () => {
  it("is optional and trimmed", () => {
    expect(contactsSchema.parse({})).toEqual({});
    expect(contactsSchema.parse({ kaspi: "  +7 700 123 45 67 " })).toEqual({
      kaspi: "+7 700 123 45 67",
    });
  });

  it("rejects blank and oversized values", () => {
    expect(contactsSchema.safeParse({ kaspi: "   " }).success).toBe(false);
    expect(contactsSchema.safeParse({ kaspi: "x".repeat(201) }).success).toBe(false);
    expect(contactsSchema.safeParse({ kaspi: "x".repeat(200) }).success).toBe(true);
  });
});
