import type { Availability, Contacts, Policies } from "./business-model";

export const CONTACT_FIELDS = [
  ["phone", "Phone"],
  ["email", "Email"],
  ["whatsapp", "WhatsApp"],
  ["telegram", "Telegram"],
  ["instagram", "Instagram"],
  ["website", "Website"],
  ["address", "Address"],
] as const satisfies readonly (readonly [keyof Contacts, string])[];

export const POLICY_FIELDS = [
  ["delivery", "Delivery"],
  ["payment", "Payment"],
  ["returns", "Returns"],
  ["working_hours", "Working hours"],
  ["other", "Other"],
] as const satisfies readonly (readonly [keyof Policies, string])[];

export const AVAILABILITY_LABELS = [
  ["in_stock", "In stock"],
  ["out_of_stock", "Out of stock"],
  ["unknown", "To be confirmed"],
] as const satisfies readonly (readonly [Availability, string])[];
