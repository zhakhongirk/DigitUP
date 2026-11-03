import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "X-Storefront-Signature";
export const TIMESTAMP_HEADER = "X-Storefront-Timestamp";

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

/** HMAC-SHA256 over "<timestamp>.<body>", hex encoded and prefixed with sha256=. */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function webhookHeaders(secret: string, body: string, now = Date.now()) {
  const timestamp = Math.floor(now / 1000);
  return {
    "content-type": "application/json",
    [TIMESTAMP_HEADER]: String(timestamp),
    [SIGNATURE_HEADER]: signWebhook(secret, timestamp, body),
  };
}

export function verifyWebhook(
  secret: string,
  timestamp: number,
  body: string,
  signature: string,
): boolean {
  const expected = Buffer.from(signWebhook(secret, timestamp, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
