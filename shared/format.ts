const PREFIX: Record<string, string> = { USD: "$", EUR: "€" };
const SUFFIX: Record<string, string> = { KZT: "₸", RUB: "₽" };

function group(amount: number, decimal: string): string {
  const rounded = Math.round(Math.abs(amount) * 100) / 100;
  const [whole = "0", fraction] = rounded.toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const text = fraction && fraction !== "00" ? `${grouped}${decimal}${fraction}` : grouped;
  return amount < 0 && rounded > 0 ? `-${text}` : text;
}

/** Display price for shoppers: "42 000 ₸", "$1 250", "1 234 ABC". */
export function formatPrice(
  amount: number,
  currency: string | null | undefined,
  lang: "en" | "ru" | "kk" = "en",
): string {
  const code = (currency ?? "").trim().toUpperCase();
  if (!Number.isFinite(amount)) return code ? `${amount} ${code}` : String(amount);
  const text = group(amount, lang === "en" ? "." : ",");
  const prefix = PREFIX[code];
  if (prefix) return text.startsWith("-") ? `-${prefix}${text.slice(1)}` : `${prefix}${text}`;
  const suffix = SUFFIX[code] ?? code;
  return suffix ? `${text} ${suffix}` : text;
}
