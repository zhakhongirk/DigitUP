import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenAiCompatibleClient } from "@/server/llm/client";
import { LlmError } from "@/server/llm";

let server: Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  server = undefined;
});

async function listen(handler: Parameters<typeof createServer>[1]) {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

describe("request timeout", () => {
  it("surfaces a slow upstream as a timeout error", async () => {
    const baseURL = await listen(() => {});
    const client = createOpenAiCompatibleClient({
      apiKey: "k",
      model: "m",
      mode: "native",
      baseURL,
      timeoutMs: 80,
      maxRetries: 0,
    });
    const error = await client
      .chat({ messages: [{ role: "user", content: "hi" }] })
      .catch((e) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error.kind).toBe("timeout");
  });

  it("retries a failed request before giving up", async () => {
    let calls = 0;
    const baseURL = await listen((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.statusCode = 503;
        res.end("{}");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 0,
          model: "m",
          choices: [
            { index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } },
          ],
        }),
      );
    });
    const client = createOpenAiCompatibleClient({
      apiKey: "k",
      model: "m",
      mode: "native",
      baseURL,
      timeoutMs: 2000,
      maxRetries: 1,
    });
    const result = await client.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(result.content).toBe("ok");
    expect(calls).toBe(2);
  });
});
