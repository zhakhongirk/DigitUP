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
import { formatPrice } from "@/shared/format";
import "./chat.css";

type Props = { slug: string; storeName: string };

const NETWORK_ERROR = "Could not reach the store assistant. Check your connection and try again.";
const GENERIC_ERROR = "Something went wrong. Please try again.";

function formatMoney(value: number | string, currency: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return `${value} ${currency}`.trim();
  return formatPrice(amount, currency);
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => Array.from(w)[0] ?? "")
      .join("")
      .toUpperCase() || "S"
  );
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
      <div className="chat-order-head">
        <b>Order summary</b>
        <span className={sent ? "chip chip-ok" : "chip chip-neutral"}>
          {sent ? "Submitted" : "Draft"}
        </span>
      </div>
      <ul className="chat-order-lines">
        {order.items.map((line, i) => (
          <li key={i}>
            <span>
              {line.title}
              <span className="chat-order-qty"> × {line.quantity}</span>
            </span>
            <span>{formatMoney(line.lineTotal, line.currency || order.currency)}</span>
          </li>
        ))}
        <li className="chat-order-total">
          <b>Total</b>
          <b>{formatMoney(order.total, order.currency)}</b>
        </li>
      </ul>
      {sent ? (
        <p className="chat-order-sent">Order sent to the store. The store will confirm it.</p>
      ) : (
        <div className="chat-order-actions">
          {order.nextStep ? <p className="chat-order-hint">{order.nextStep}</p> : null}
          {order.error ? (
            <p className="chat-error-text" role="alert">
              {order.error}
            </p>
          ) : null}
          <button
            type="button"
            className="btn chat-confirm"
            disabled={order.confirming}
            onClick={() => onConfirm(order.orderId)}
          >
            {order.confirming ? "Sending..." : "Confirm order"}
          </button>
        </div>
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
      <div className="chat-head">
        <div className="chat-avatar" aria-hidden="true">
          {initials(storeName)}
        </div>
        <div className="chat-head-text">
          <h2 className="chat-title">{storeName} Assistant</h2>
          <span className="chat-sub">Answers only from the store&apos;s catalog</span>
        </div>
      </div>

      <div className="chat-log" role="log" aria-live="polite" aria-label={`Chat with ${storeName}`}>
        {disabled ? (
          <div className="chat-notice" role="status">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <path d="M4 6a2 2 0 012-2h12a2 2 0 012 2v9a2 2 0 01-2 2H9l-5 4z" />
            </svg>
            <p>{UNAVAILABLE_NOTICE}</p>
          </div>
        ) : null}
        {state.loaded && state.items.length === 0 && !disabled ? (
          <p className="chat-note chat-empty">Ask about products, availability or ordering.</p>
        ) : null}
        {state.items.map((item) => {
          if (item.kind === "message") {
            return (
              <div key={item.id} className={`chat-bubble chat-bubble-${item.role}`}>
                <span className="sr-only">{item.role === "user" ? "You: " : "Assistant: "}</span>
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
            <span className="chat-bubble chat-bubble-assistant chat-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="chat-activity">{state.activity ?? "Typing"}</span>
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
        <label htmlFor="chat-input" className="sr-only">
          Message to the store assistant
        </label>
        <textarea
          id="chat-input"
          className="chat-input"
          rows={1}
          maxLength={MAX_MESSAGE_CHARS}
          placeholder={disabled ? "Assistant unavailable" : "Message"}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="submit" className="chat-send" aria-label="Send" disabled={!canSend}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            aria-hidden="true"
          >
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </form>
    </div>
  );
}
