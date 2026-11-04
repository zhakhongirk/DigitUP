import type { TenantContext } from "@/server/services/context";
import type { ConversationsService } from "@/server/services/conversations";

export interface SearchLogEntry {
  query: string;
  titles: string[];
  total: number;
}

/** Records a search of an outside agent; sessionKey is the id the agent passed, if any. */
export type SearchLogger = (entry: SearchLogEntry, sessionKey?: string) => Promise<void>;

const TITLES_SHOWN = 3;

export function describeSearch({ titles, total }: SearchLogEntry): string {
  if (total === 0) return "No offers found";
  const shown = titles.slice(0, TITLES_SHOWN).join(", ");
  const noun = total === 1 ? "offer" : "offers";
  return shown ? `Found ${total} ${noun}: ${shown}` : `Found ${total} ${noun}`;
}

/**
 * Appends the query and a one-line answer to a conversation, either the bound one
 * or the external agent conversation of the session. Never throws.
 */
export function conversationSearchLogger(
  conversations: Pick<ConversationsService, "getOrCreate" | "appendMessages">,
  ctx: TenantContext,
  target: { conversationId?: string; fallbackKey?: string },
): SearchLogger {
  return async (entry, sessionKey) => {
    try {
      let id = target.conversationId;
      if (!id) {
        const key = sessionKey ?? target.fallbackKey;
        if (!key) return;
        const conversation = await conversations.getOrCreate(ctx, {
          agent: "customer",
          channel: "external_agent",
          sessionKey: key,
        });
        id = conversation.id;
      }
      await conversations.appendMessages(ctx, id, [
        { role: "user", content: entry.query },
        { role: "assistant", content: describeSearch(entry) },
      ]);
    } catch (error) {
      console.error("[mcp] could not log search", error);
    }
  };
}
