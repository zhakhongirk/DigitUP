export interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat: { id: number | string; type?: string };
    from?: { language_code?: string };
  };
}

export interface TelegramClient {
  getUpdates(input: {
    offset: number;
    timeoutSeconds: number;
    signal?: AbortSignal;
  }): Promise<TelegramUpdate[]>;
  sendMessage(chatId: string, text: string): Promise<void>;
}

export interface TelegramConfig {
  token: string;
  botUsername: string;
}

export function telegramConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TelegramConfig | null {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const botUsername = env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  if (!token || !botUsername) return null;
  return { token, botUsername };
}

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export function createHttpTelegramClient(
  token: string,
  fetchImpl: typeof fetch = fetch,
): TelegramClient {
  async function call<T>(method: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const payload = (await response.json().catch(() => null)) as ApiResponse<T> | null;
    if (!response.ok || !payload?.ok) {
      throw new Error(`telegram ${method} failed: ${payload?.description ?? response.status}`);
    }
    return payload.result as T;
  }

  return {
    getUpdates: ({ offset, timeoutSeconds, signal }) =>
      call<TelegramUpdate[]>(
        "getUpdates",
        { offset, timeout: timeoutSeconds, allowed_updates: ["message"] },
        signal,
      ),
    sendMessage: async (chatId, text) => {
      await call("sendMessage", {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      });
    },
  };
}
