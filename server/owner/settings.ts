import { CONTACT_FIELDS, POLICY_FIELDS } from "@/shared/labels";
import type { Contacts, Policies } from "@/shared/business-model";

export interface ProfileInput {
  name: string;
  description: string;
  category: string | null;
  contacts: Contacts;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export function parseProfileForm(form: FormData): ProfileInput {
  const contacts: Contacts = {};
  for (const [key] of CONTACT_FIELDS) {
    const value = text(form, `contact.${key}`);
    if (value) contacts[key] = value;
  }
  return {
    name: text(form, "name"),
    description: text(form, "description"),
    category: text(form, "category") || null,
    contacts,
  };
}

export function parsePoliciesForm(form: FormData): Policies {
  const policies: Policies = {
    delivery: null,
    payment: null,
    returns: null,
    working_hours: null,
    other: null,
  };
  for (const [key] of POLICY_FIELDS) policies[key] = text(form, `policy.${key}`) || null;
  return policies;
}
