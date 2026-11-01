import { describe, expect, it } from "vitest";
import {
  chatReducer,
  flushNdjson,
  initialChatState,
  parseNdjsonChunk,
  type ChatAction,
  type ChatState,
  type StreamEvent,
} from "@/app/s/[slug]/chat-state";

const draft = {
  order_id: "o-1",
  status: "draft",
  items: [{ title: "Runner", quantity: 2, unitPrice: 50, currency: "USD", lineTotal: 100 }],
  total: 100,
  currency: "USD",
  total_label: "$100.00",
  next_step: "Confirm to send",
};

function run(actions: ChatAction[], from: ChatState = initialChatState): ChatState {
  return actions.reduce(chatReducer, from);
}

const ev = (event: StreamEvent): ChatAction => ({ type: "stream_event", event });

describe("parseNdjsonChunk", () => {
  it("parses whole lines", () => {
    const r = parseNdjsonChunk("", '{"type":"message","content":"hi"}\n{"type":"done"}\n');
    expect(r.events).toHaveLength(2);
    expect(r.rest).toBe("");
  });

  it("joins an object split across chunks", () => {
    const a = parseNdjsonChunk("", '{"type":"mess');
    expect(a.events).toEqual([]);
    const b = parseNdjsonChunk(a.rest, 'age","content":"hi"}\n');
    expect(b.events).toEqual([{ type: "message", content: "hi" }]);
  });

  it("keeps a trailing partial line until the next chunk", () => {
    const a = parseNdjsonChunk("", '{"type":"done"}\n{"type":"err');
    expect(a.events).toHaveLength(1);
    expect(a.rest).toBe('{"type":"err');
  });

  it("ignores blank lines", () => {
    const r = parseNdjsonChunk("", '\n  \n{"type":"done"}\n\n');
    expect(r.events).toHaveLength(1);
    expect(r.invalid).toBe(0);
  });

  it("counts invalid lines and keeps later events", () => {
    const r = parseNdjsonChunk("", 'oops\n{"x":1}\n{"type":"done"}\n');
    expect(r.invalid).toBe(2);
    expect(r.events).toEqual([{ type: "done" }]);
  });

  it("flushes a final line without newline", () => {
    expect(flushNdjson('{"type":"done"}').events).toHaveLength(1);
    expect(flushNdjson("  ").events).toEqual([]);
  });
});

describe("chatReducer", () => {
  it("adds the user message and starts sending", () => {
    const s = run([{ type: "user_sent", text: "hello" }]);
    expect(s.sending).toBe(true);
    expect(s.items[0]).toMatchObject({ kind: "message", role: "user", content: "hello" });
  });

  it("sets activity on tool calls", () => {
    const s = run([ev({ type: "tool_call", name: "search_offers" })]);
    expect(s.activity).toBe("Searching the catalog");
  });

  it("creates an order card from a draft result", () => {
    const s = run([ev({ type: "tool_result", name: "create_order", data: draft })]);
    expect(s.items[0]).toMatchObject({
      kind: "order",
      order: { orderId: "o-1", status: "draft", totalLabel: "$100.00" },
    });
  });

  it("marks the same order as sent on a submitted result", () => {
    const s = run([
      ev({ type: "tool_result", name: "create_order", data: draft }),
      ev({ type: "tool_result", name: "create_order", data: { ...draft, status: "submitted" } }),
    ]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ order: { status: "submitted" } });
  });

  it("appends an assistant message and clears activity", () => {
    const s = run([
      ev({ type: "tool_call", name: "search_offers" }),
      ev({ type: "message", content: "Here you go" }),
    ]);
    expect(s.activity).toBeNull();
    expect(s.items.at(-1)).toMatchObject({ role: "assistant", content: "Here you go" });
  });

  it("adds a note for a successful inquiry", () => {
    const s = run([
      ev({ type: "tool_result", name: "submit_inquiry", data: { inquiry_id: "i-1" } }),
    ]);
    expect(s.items[0]).toMatchObject({ kind: "note", text: "Inquiry sent to the store" });
  });

  it("sets a retryable error on error events and stops sending", () => {
    const s = run([{ type: "user_sent", text: "x" }, ev({ type: "error", message: "Nope" })]);
    expect(s.sending).toBe(false);
    expect(s.error).toEqual({ message: "Nope", retryable: true });
  });

  it("switches to unavailable", () => {
    const s = run([{ type: "user_sent", text: "x" }, { type: "unavailable" }]);
    expect(s.available).toBe(false);
    expect(s.sending).toBe(false);
  });

  it("loads history and availability", () => {
    const s = run([
      { type: "history_loaded", available: false, messages: [{ role: "user", content: "a" }] },
    ]);
    expect(s.available).toBe(false);
    expect(s.items).toHaveLength(1);
  });

  it("handles confirm success and failure", () => {
    const base = run([ev({ type: "tool_result", name: "create_order", data: draft })]);
    const started = chatReducer(base, { type: "confirm_started", orderId: "o-1" });
    expect(started.items[0]).toMatchObject({ order: { confirming: true } });
    const failed = chatReducer(started, {
      type: "confirm_failed",
      orderId: "o-1",
      message: "Already closed",
    });
    expect(failed.items[0]).toMatchObject({
      order: { confirming: false, error: "Already closed" },
    });
    const ok = chatReducer(failed, {
      type: "confirm_succeeded",
      order: { ...draft, status: "submitted" },
    });
    expect(ok.items[0]).toMatchObject({
      order: { status: "submitted", confirming: false, error: null },
    });
  });
});
