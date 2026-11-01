"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import {
  MAX_MESSAGE_CHARS,
  UNAVAILABLE_NOTICE,
  chatReducer,
  flushNdjson,
  initialChatState,
  parseNdjsonChunk,
  toOrderView,
  type OrderCard,
  type StreamEvent,
} from "./chat-state";
import "./chat.css";

type Props = { slug: string; storeName: string };

const NETWORK_ERROR = "Could not reach the store assistant. Check your connection and try again.";
const GENERIC_ERROR = "Something went wrong. Please try again.";

function formatMoney(value: number | string, currency: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return `${value} ${currency}`.trim();
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return `${amount} ${currency}`.trim();
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body.message === "string" && body.message) return body.message;
  } catch {
    // Fall through to the generic text.
  }
  return GENERIC_ERROR;
}

function OrderSummary({
  order,
  onConfirm,
}: {
  order: OrderCard;
  onConfirm: (orderId: string) => void;
}) {
  const sent = order.status !== "draft";
  return (
    <section className="chat-order" aria-label="Order summary">
      <ul className="chat-order-lines">
        {order.items.map((line, i) => (
          <li key={i}>
            <span>
              {line.quantity} x {line.title}
            </span>
            <span>{formatMoney(line.lineTotal, line.currency || order.currency)}</span>
          </li>
        ))}
      </ul>
      <p className="chat-order-total">
        <span>Total</span>
        <span>{order.totalLabel ?? formatMoney(order.total, order.currency)}</span>
      </p>
      {sent ? (
        <p className="chat-order-sent">Order sent to the store</p>
      ) : (
        <>
          {order.nextStep ? <p className="chat-order-hint">{order.nextStep}</p> : null}
          {order.error ? (
            <p className="chat-error-text" role="alert">
              {order.error}
            </p>
          ) : null}
          <button
            type="button"
            className="chat-button"
            disabled={order.confirming}
            onClick={() => onConfirm(order.orderId)}
          >
            {order.confirming ? "Sending..." : "Confirm order"}
          </button>
        </>
      )}
    </section>
  );
}

export function ChatPanel({ slug, storeName }: Props) {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [draft, setDraft] = useState("");
  const sendingRef = useRef(false);
  const lastMessageRef = useRef("");
  const endRef = useRef<HTMLDivElement>(null);
  const base = `/api/s/${encodeURIComponent(slug)}/chat`;

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(base, { signal: controller.signal });
        if (!res.ok) throw new Error("history");
        const body = (await res.json()) as {
          available?: boolean;
          messages?: { role: "user" | "assistant"; content: string }[];
        };
        dispatch({
          type: "history_loaded",
          available: body.available !== false,
          messages: body.messages ?? [],
        });
      } catch {
        if (!controller.signal.aborted) dispatch({ type: "history_failed" });
      }
    })();
    return () => controller.abort();
  }, [base]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [state.items.length, state.activity, state.sending, state.error]);

  const stream = useCallback(
    async (text: string) => {
      sendingRef.current = true;
      try {
        const res = await fetch(base, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: text }),
        });
        if (res.status === 503) {
          dispatch({ type: "unavailable" });
          return;
        }
        if (!res.ok || !res.body) {
          dispatch({ type: "stream_failed", message: await errorMessage(res) });
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finished = false;
        const handle = (events: StreamEvent[]) => {
          for (const event of events) {
            if (event.type === "done" || event.type === "error") finished = true;
            dispatch({ type: "stream_event", event });
          }
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const parsed = parseNdjsonChunk(buffer, decoder.decode(value, { stream: true }));
          buffer = parsed.rest;
          handle(parsed.events);
        }
        handle(flushNdjson(buffer + decoder.decode()).events);
        if (!finished) dispatch({ type: "stream_failed", message: NETWORK_ERROR });
      } catch {
        dispatch({ type: "stream_failed", message: NETWORK_ERROR });
      } finally {
        sendingRef.current = false;
      }
    },
    [base],
  );

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || text.length > MAX_MESSAGE_CHARS || sendingRef.current || !state.available) return;
    sendingRef.current = true;
    lastMessageRef.current = text;
    setDraft("");
    dispatch({ type: "user_sent", text });
    void stream(text);
  }, [draft, state.available, stream]);

  const retry = useCallback(() => {
    if (sendingRef.current || !lastMessageRef.current) return;
    sendingRef.current = true;
    dispatch({ type: "retry_started" });
    void stream(lastMessageRef.current);
  }, [stream]);

  const confirm = useCallback(
    async (orderId: string) => {
      dispatch({ type: "confirm_started", orderId });
      try {
        const res = await fetch(
          `/api/s/${encodeURIComponent(slug)}/orders/${encodeURIComponent(orderId)}/confirm`,
          { method: "POST" },
        );
        if (!res.ok) {
          dispatch({ type: "confirm_failed", orderId, message: await errorMessage(res) });
          return;
        }
        const view = toOrderView(await res.json());
        if (view) dispatch({ type: "confirm_succeeded", order: view });
        else dispatch({ type: "confirm_failed", orderId, message: GENERIC_ERROR });
      } catch {
        dispatch({ type: "confirm_failed", orderId, message: NETWORK_ERROR });
      }
    },
    [slug],
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const disabled = !state.available;
  const canSend = !disabled && !state.sending && draft.trim() !== "";

  return (
    <div className="chat">
      {disabled ? (
        <p className="chat-notice" role="status">
          {UNAVAILABLE_NOTICE}
        </p>
      ) : null}

      <div className="chat-log" role="log" aria-live="polite" aria-label={`Chat with ${storeName}`}>
        {state.loaded && state.items.length === 0 && !disabled ? (
          <p className="chat-empty">Ask about products, availability or ordering.</p>
        ) : null}
        {state.items.map((item) => {
          if (item.kind === "message") {
            return (
              <div key={item.id} className={`chat-bubble chat-bubble-${item.role}`}>
                <span className="chat-sr">{item.role === "user" ? "You: " : "Assistant: "}</span>
                {item.content}
              </div>
            );
          }
          if (item.kind === "order") {
            return <OrderSummary key={item.id} order={item.order} onConfirm={confirm} />;
          }
          return (
            <p key={item.id} className="chat-note">
              {item.text}
            </p>
          );
        })}
        {state.sending ? (
          <div className="chat-typing">
            <span className="chat-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>{state.activity ?? "Typing"}</span>
          </div>
        ) : null}
        {state.error ? (
          <p className="chat-error" role="alert">
            <span>{state.error.message}</span>
            {state.error.retryable ? (
              <button type="button" className="chat-link" onClick={retry}>
                Try again
              </button>
            ) : null}
          </p>
        ) : null}
        <div ref={endRef} />
      </div>

      <form className="chat-form" onSubmit={onSubmit}>
        <label htmlFor="chat-input" className="chat-sr">
          Message to the store assistant
        </label>
        <textarea
          id="chat-input"
          className="chat-input"
          rows={2}
          maxLength={MAX_MESSAGE_CHARS}
          placeholder={disabled ? "Assistant unavailable" : "Type your message"}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="submit" className="chat-button" disabled={!canSend}>
          Send
        </button>
      </form>
    </div>
  );
}
