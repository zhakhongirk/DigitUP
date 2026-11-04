export const CHAT_PREFILL_EVENT = "store-chat:prefill";

export type ChatPrefill = { text: string; send: boolean };

export function orderMessage(title: string, verb: "order" | "book"): string {
  return `I'd like to ${verb} ${title}`;
}

export function questionDraft(title: string): string {
  return `Question about ${title}: `;
}

export function sizeOrderMessage(title: string, size: string): string {
  return `I'd like to order ${title}, size ${size}`;
}
