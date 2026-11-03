import { t, type Lang } from "@/server/storefront/i18n";

export function availabilityText(lang: Lang, availability: string): string {
  if (availability === "in_stock") return t(lang, "availInStock");
  if (availability === "out_of_stock") return t(lang, "availOutOfStock");
  return t(lang, "availUnknown");
}

const POLICY_LABELS: Record<Exclude<Lang, "en">, Record<string, string>> = {
  ru: {
    delivery: "Доставка",
    payment: "Оплата",
    returns: "Возврат",
    working_hours: "Часы работы",
    other: "Другое",
  },
  kk: {
    delivery: "Жеткізу",
    payment: "Төлем",
    returns: "Қайтару",
    working_hours: "Жұмыс уақыты",
    other: "Басқа",
  },
};

export function policyLabel(lang: Lang, key: string, label: string): string {
  return lang === "en" ? label : (POLICY_LABELS[lang][key] ?? label);
}
