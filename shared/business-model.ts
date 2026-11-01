/**
 * Business Model contract.
 *
 * One schema shared by the Business Agent output, the review screen,
 * provisioning and the seed. Unknown commercial data is expressed through
 * explicit states (`price_status`, `availability`), never invented values.
 */
import { z } from "zod";

export const offerKindSchema = z.enum(["product", "service", "other"]);
export const priceStatusSchema = z.enum(["confirmed", "on_request"]);
export const availabilitySchema = z.enum(["in_stock", "out_of_stock", "unknown"]);
export const offerStatusSchema = z.enum(["active", "draft", "archived"]);

export type OfferKind = z.infer<typeof offerKindSchema>;
export type PriceStatus = z.infer<typeof priceStatusSchema>;
export type Availability = z.infer<typeof availabilitySchema>;
export type OfferStatus = z.infer<typeof offerStatusSchema>;

const keySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "must be lower_snake_case, starting with a letter")
  .max(64);

const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, "must be an ISO 4217 code such as USD or KZT");

export const attributeTypeSchema = z.enum(["text", "number", "boolean", "enum", "list"]);

export const attributeDefinitionSchema = z
  .object({
    key: keySchema,
    label: z.string().min(1),
    type: attributeTypeSchema,
    /** Allowed values for `enum` and `list` attributes. */
    options: z.array(z.string().min(1)).optional(),
    unit: z.string().min(1).optional(),
    required: z.boolean().default(false),
  })
  .refine((attr) => attr.type !== "enum" || (attr.options && attr.options.length > 0), {
    message: "enum attributes need options",
    path: ["options"],
  });

export type AttributeDefinition = z.infer<typeof attributeDefinitionSchema>;

export const offerTypeSchema = z.object({
  key: keySchema,
  name: z.string().min(1),
  kind: offerKindSchema,
  attributes: z.array(attributeDefinitionSchema).default([]),
});

export type OfferType = z.infer<typeof offerTypeSchema>;

export const attributeValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);

export type AttributeValue = z.infer<typeof attributeValueSchema>;

export const offerSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().default(""),
    category: z.string().min(1).nullable().default(null),
    /** Key of an offer type defined in the same model. */
    offer_type: keySchema,
    attributes: z.record(z.string(), attributeValueSchema).default({}),
    price: z.number().nonnegative().nullable().default(null),
    currency: currencySchema.nullable().default(null),
    price_status: priceStatusSchema,
    availability: availabilitySchema.default("unknown"),
    status: offerStatusSchema.default("active"),
  })
  .superRefine((offer, ctx) => {
    if (offer.price_status === "confirmed" && offer.price === null) {
      ctx.addIssue({
        code: "custom",
        path: ["price"],
        message: "a confirmed price needs a value; use price_status on_request when unknown",
      });
    }
    if (offer.price !== null && offer.currency === null) {
      ctx.addIssue({ code: "custom", path: ["currency"], message: "a price needs a currency" });
    }
  });

export type Offer = z.infer<typeof offerSchema>;

export const contactsSchema = z.object({
  phone: z.string().min(1).optional(),
  email: z.email().optional(),
  whatsapp: z.string().min(1).optional(),
  telegram: z.string().min(1).optional(),
  instagram: z.string().min(1).optional(),
  website: z.string().min(1).optional(),
  address: z.string().min(1).optional(),
});

export type Contacts = z.infer<typeof contactsSchema>;

/** Contact fields a shopper can actually reach the business through. */
export const CONTACT_CHANNELS = [
  "phone",
  "email",
  "whatsapp",
  "telegram",
  "instagram",
  "website",
] as const satisfies readonly (keyof Contacts)[];

export const profileSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  category: z.string().min(1).nullable().default(null),
  contacts: contactsSchema.default({}),
});

export type Profile = z.infer<typeof profileSchema>;

/** Free-text commercial terms; `null` means not provided yet (shown as "to be confirmed"). */
export const policiesSchema = z.object({
  delivery: z.string().min(1).nullable().default(null),
  payment: z.string().min(1).nullable().default(null),
  returns: z.string().min(1).nullable().default(null),
  working_hours: z.string().min(1).nullable().default(null),
  other: z.string().min(1).nullable().default(null),
});

export type Policies = z.infer<typeof policiesSchema>;

export const missingInfoItemSchema = z.object({
  /** Dotted path of the missing field, e.g. `policies.delivery` or `offers[3].price`. */
  field: z.string().min(1),
  /** Question to ask the owner. */
  question: z.string().min(1),
  severity: z.enum(["blocking", "recommended"]).default("recommended"),
});

export type MissingInfoItem = z.infer<typeof missingInfoItemSchema>;

export interface AttributeIssue {
  key: string;
  message: string;
}

/** Checks offer attribute values against the attribute definitions of its offer type. */
export function offerAttributeIssues(
  attributes: Record<string, AttributeValue>,
  type: Pick<OfferType, "key" | "attributes">,
): AttributeIssue[] {
  const defs = new Map(type.attributes.map((attr) => [attr.key, attr]));
  const issues: AttributeIssue[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    const def = defs.get(key);
    if (!def) {
      issues.push({
        key,
        message: `attribute "${key}" is not defined on offer type "${type.key}"`,
      });
      continue;
    }
    const problem = checkAttributeValue(def, value);
    if (problem) issues.push({ key, message: problem });
  }
  return issues;
}

function checkAttributeValue(def: AttributeDefinition, value: AttributeValue): string | null {
  switch (def.type) {
    case "text":
      return typeof value === "string" ? null : "expected text";
    case "number":
      return typeof value === "number" ? null : "expected a number";
    case "boolean":
      return typeof value === "boolean" ? null : "expected true or false";
    case "enum":
      if (typeof value !== "string") return "expected one of the options";
      return def.options?.includes(value) ? null : `"${value}" is not one of the options`;
    case "list": {
      if (!Array.isArray(value)) return "expected a list";
      if (!def.options) return null;
      const unknown = value.filter((v) => !def.options?.includes(v));
      return unknown.length === 0 ? null : `not in options: ${unknown.join(", ")}`;
    }
  }
}

export const businessModelSchema = z
  .object({
    profile: profileSchema,
    offer_types: z.array(offerTypeSchema).default([]),
    offers: z.array(offerSchema).default([]),
    policies: policiesSchema.default({
      delivery: null,
      payment: null,
      returns: null,
      working_hours: null,
      other: null,
    }),
    missing_info: z.array(missingInfoItemSchema).default([]),
  })
  .superRefine((model, ctx) => {
    const types = new Map<string, OfferType>();
    model.offer_types.forEach((type, i) => {
      if (types.has(type.key)) {
        ctx.addIssue({
          code: "custom",
          path: ["offer_types", i, "key"],
          message: `duplicate offer type key "${type.key}"`,
        });
      }
      types.set(type.key, type);

      const attrKeys = new Set<string>();
      type.attributes.forEach((attr, j) => {
        if (attrKeys.has(attr.key)) {
          ctx.addIssue({
            code: "custom",
            path: ["offer_types", i, "attributes", j, "key"],
            message: `duplicate attribute key "${attr.key}"`,
          });
        }
        attrKeys.add(attr.key);
      });
    });

    model.offers.forEach((offer, i) => {
      const type = types.get(offer.offer_type);
      if (!type) {
        ctx.addIssue({
          code: "custom",
          path: ["offers", i, "offer_type"],
          message: `unknown offer type "${offer.offer_type}"`,
        });
        return;
      }
      for (const issue of offerAttributeIssues(offer.attributes, type)) {
        ctx.addIssue({
          code: "custom",
          path: ["offers", i, "attributes", issue.key],
          message: issue.message,
        });
      }
    });
  });

export type BusinessModel = z.infer<typeof businessModelSchema>;
/** Input shape (before defaults are applied), e.g. for agent output and seed files. */
export type BusinessModelInput = z.input<typeof businessModelSchema>;

export interface LaunchReadiness {
  ready: boolean;
  /** Human-readable reasons the model cannot launch yet. */
  missing: string[];
}

/**
 * Minimal launch rule: a business name, a description of what it offers, and
 * one contact channel are enough to go live.
 */
export function checkLaunchReadiness(model: BusinessModel): LaunchReadiness {
  const missing: string[] = [];

  if (model.profile.name.trim() === "") missing.push("business name");

  const hasOfferDescription =
    model.profile.description.trim() !== "" ||
    model.offers.some((offer) => offer.status === "active");
  if (!hasOfferDescription) missing.push("a description of what the business offers");

  const hasContact = CONTACT_CHANNELS.some((channel) => {
    const value = model.profile.contacts[channel];
    return typeof value === "string" && value.trim() !== "";
  });
  if (!hasContact) missing.push("one contact channel (phone, email, messenger or website)");

  return { ready: missing.length === 0, missing };
}
