import { request } from "node:https";
import { guardedLookup, parseWebhookUrl } from "./guard";
import { webhookHeaders } from "./sign";

export const WEBHOOK_TIMEOUT_MS = 5000;
export const WEBHOOK_BACKOFF_MS = [500, 2000] as const;

export type PostWebhook = (
  url: string,
  headers: Record<string, string>,
  body: string,
) => Promise<{ status: number }>;

/** One HTTPS POST that never follows redirects and refuses non-public addresses at connect time. */
export const postWebhook: PostWebhook = (rawUrl, headers, body) =>
  new Promise((resolve, reject) => {
    const url = parseWebhookUrl(rawUrl);
    const req = request(
      url,
      {
        method: "POST",
        headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
        timeout: WEBHOOK_TIMEOUT_MS,
        lookup: guardedLookup as never,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("Webhook timed out")));
    req.on("error", reject);
    req.end(body);
  });

export type DeliveryOutcome =
  | { ok: true; attempts: number }
  | { ok: false; attempts: number; retryable: boolean; reason: string };

/** 2xx is delivered; 408, 429 and 5xx are worth retrying; other statuses are final. */
export function classifyStatus(status: number): "ok" | "retry" | "fail" {
  if (status >= 200 && status < 300) return "ok";
  if (status === 408 || status === 429 || status >= 500) return "retry";
  return "fail";
}

export interface DeliverOptions {
  url: string;
  secret: string;
  body: string;
  post?: PostWebhook;
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: readonly number[];
  now?: () => number;
}

export async function deliverWithRetry(options: DeliverOptions): Promise<DeliveryOutcome> {
  const post = options.post ?? postWebhook;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const backoff = options.backoffMs ?? WEBHOOK_BACKOFF_MS;
  const now = options.now ?? Date.now;
  let reason = "";
  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    if (attempt > 0) await sleep(backoff[attempt - 1]!);
    try {
      const { status } = await post(
        options.url,
        webhookHeaders(options.secret, options.body, now()),
        options.body,
      );
      const verdict = classifyStatus(status);
      if (verdict === "ok") return { ok: true, attempts: attempt + 1 };
      reason = `status ${status}`;
      if (verdict === "fail") return { ok: false, attempts: attempt + 1, retryable: false, reason };
    } catch (error) {
      reason = error instanceof Error ? error.message : "request failed";
    }
  }
  return { ok: false, attempts: backoff.length + 1, retryable: true, reason };
}
