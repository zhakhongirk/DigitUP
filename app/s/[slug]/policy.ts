const ALIASES: Record<string, string[]> = {
  working_hours: ["working hours", "opening hours", "hours"],
};

/** Drops a leading "Delivery:" style label that repeats the heading above the text. */
export function stripPolicyLabel(key: string, label: string, text: string): string {
  const names = [label, key.replace(/_/g, " "), ...(ALIASES[key] ?? [])].map((n) =>
    n.trim().toLowerCase(),
  );
  const match = /^([^\n:]{2,40}):\s*(\S[\s\S]*)$/u.exec(text);
  if (!match) return text;
  return names.includes((match[1] ?? "").trim().toLowerCase()) ? (match[2] ?? text) : text;
}
