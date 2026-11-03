import { t, type Lang } from "@/server/storefront/i18n";

export function availabilityText(lang: Lang, availability: string): string {
  if (availability === "in_stock") return t(lang, "availInStock");
  if (availability === "out_of_stock") return t(lang, "availOutOfStock");
  return t(lang, "availUnknown");
}

const POLICY_LABELS_RU: Record<string, string> = {
  delivery: "Доставка",
  payment: "Оплата",
  returns: "Возврат",
  working_hours: "Часы работы",
  other: "Другое",
};

export function policyLabel(lang: Lang, key: string, label: string): string {
  return lang === "ru" ? (POLICY_LABELS_RU[key] ?? label) : label;
}
