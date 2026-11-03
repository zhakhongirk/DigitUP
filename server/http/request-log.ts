import { log } from "@/server/log";

export function withRequestLog<A extends unknown[]>(
  handler: (request: Request, ...args: A) => Promise<Response>,
  slugOf?: (...args: A) => Promise<string | undefined>,
) {
  return async (request: Request, ...args: A): Promise<Response> => {
    const started = Date.now();
    const requestId = request.headers.get("x-request-id") ?? undefined;
    const path = new URL(request.url).pathname;
    const base = { requestId, method: request.method, path };
    log.info("http.request", base);
    try {
      const response = await handler(request, ...args);
      const slug = slugOf ? await slugOf(...args).catch(() => undefined) : undefined;
      log.info("http.response", {
        ...base,
        slug,
        status: response.status,
        durationMs: Date.now() - started,
      });
      return response;
    } catch (error) {
      log.error("http.error", { ...base, durationMs: Date.now() - started, error });
      throw error;
    }
  };
}
