const MIN_DIGITS = 7;
const MAX_DIGITS = 15;

/** Digits of a WhatsApp number or wa.me link; null when it is not a plausible phone number. */
export function whatsappDigits(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (/^https?:\/\//i.test(value)) {
    try {
      value = new URL(value).pathname;
    } catch {
      return null;
    }
  }
  let digits = value.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) digits = `7${digits.slice(1)}`;
  return digits.length >= MIN_DIGITS && digits.length <= MAX_DIGITS ? digits : null;
}

/** wa.me link with a prefilled message, or null when there is no usable number. */
export function whatsappLink(raw: unknown, message: string): string | null {
  const digits = whatsappDigits(raw);
  if (!digits) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}
