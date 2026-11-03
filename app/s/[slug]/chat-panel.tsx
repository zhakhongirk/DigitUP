"use client";

import Link from "next/link";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import {
  MAX_MESSAGE_CHARS,
  SUGGESTIONS,
  UI_LABELS,
  chatReducer,
  flushNdjson,
  initialChatState,
  lastUserLang,
  parseNdjsonChunk,
  toOrderView,
  type OfferChip,
  type OrderCard,
  type StreamEvent,
  type UiLang,
} from "./chat-state";
import { t, type Lang } from "@/server/storefront/i18n";
import { formatPrice } from "@/shared/format";
import { CHAT_PREFILL_EVENT, type ChatPrefill } from "./chat-bridge";
import "./chat.css";

type Props = { slug: string; storeName: string; lang: Lang };

const POLL_INTERVAL_MS = 15000;

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

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body.message === "string" && body.message) return body.message;
  } catch {
    // Fall through to the generic text.
  }
  return fallback;
}

function OrderSummary({
  slug,
  order,
  lang,
  uiLang,
  onConfirm,
}: {
  slug: string;
  order: OrderCard;
  lang: UiLang;
  uiLang: Lang;
  onConfirm: (orderId: string, phone: string) => void;
}) {
  const sent = order.status !== "draft";
  const labels = UI_LABELS[lang];
  const [phone, setPhone] = useState("");
  return (
    <section className="chat-order" aria-label={t(uiLang, "orderSummary")}>
      <div className="chat-order-head">
        <b>{t(uiLang, "orderSummary")}</b>
        <span className={sent ? "chip chip-ok" : "chip chip-neutral"}>
          {sent ? t(uiLang, "submitted") : t(uiLang, "draft")}
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
          <b>{t(uiLang, "total")}</b>
          <b>{formatMoney(order.total, order.currency)}</b>
        </li>
      </ul>
      {sent ? (
        <p className="chat-order-sent">
          {t(uiLang, "orderSent")}{" "}
          <Link href={`/s/${encodeURIComponent(slug)}/orders/${order.orderId}`}>
            {labels.track}
          </Link>
        </p>
      ) : (
        <div className="chat-order-actions">
          {order.nextStep ? <p className="chat-order-hint">{order.nextStep}</p> : null}
          <label className="chat-order-phone">
            <span>{labels.phone}</span>
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              maxLength={50}
              placeholder="+7 700 000 00 00"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </label>
          <p className="chat-order-hint">{labels.phoneHint}</p>
          {order.error ? (
            <p className="chat-error-text" role="alert">
              {order.error}
            </p>
          ) : null}
          <button
            type="button"
            className="btn chat-confirm"
            disabled={order.confirming}
            onClick={() => onConfirm(order.orderId, phone)}
          >
            {order.confirming ? labels.sending : labels.confirm}
          </button>
        </div>
      )}
    </section>
  );
}

function OfferCards({ slug, offers, lang }: { slug: string; offers: OfferChip[]; lang: Lang }) {
  return (
    <ul className="chat-offers" aria-label={t(lang, "offersFromStore")}>
      {offers.map((o) => (
        <li key={o.id}>
          <Link href={`/s/${encodeURIComponent(slug)}/offers/${o.id}`} className="chat-offer">
            <b className="chat-offer-title">{o.title}</b>
            <span className="chat-offer-price">{o.priceLabel}</span>
            {o.availabilityLabel ? (
              <span className={`status status-${o.availability}`}>{o.availabilityLabel}</span>
            ) : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function ChatPanel({ slug, storeName, lang: uiLang }: Props) {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [draft, setDraft] = useState("");
  const [fallback, setFallback] = useState(false);
  const sendingRef = useRef(false);
  const lastMessageRef = useRef("");
  const endRef = useRef<HTMLDivElement>(null);
  const base = `/api/s/${encodeURIComponent(slug)}/chat`;
  const networkError = t(uiLang, "networkError");
  const genericError = t(uiLang, "genericError");

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(base, { signal: controller.signal });
        if (!res.ok) throw new Error("history");
        const body = (await res.json()) as {
          available?: boolean;
          fallback?: boolean;
          messages?: { role: "user" | "assistant"; content: string }[];
        };
        setFallback(body.fallback === true);
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

  const loaded = state.loaded;
  useEffect(() => {
    if (!loaded) return;
    let controller: AbortController | null = null;
    const poll = async () => {
      if (document.visibilityState === "hidden" || sendingRef.current) return;
      controller = new AbortController();
      try {
        const res = await fetch(base, { signal: controller.signal });
        if (!res.ok) return;
        const body = (await res.json()) as {
          messages?: { role: "user" | "assistant"; content: string }[];
        };
        if (!sendingRef.current && body.messages) {
          dispatch({ type: "history_polled", messages: body.messages });
        }
      } catch {
        // The next tick tries again.
      }
    };
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      controller?.abort();
    };
  }, [base, loaded]);

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
          dispatch({ type: "stream_failed", message: await errorMessage(res, genericError) });
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
        if (!finished) dispatch({ type: "stream_failed", message: networkError });
      } catch {
        dispatch({ type: "stream_failed", message: networkError });
      } finally {
        sendingRef.current = false;
      }
    },
    [base, genericError, networkError],
  );

  const sendText = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text || text.length > MAX_MESSAGE_CHARS || sendingRef.current || !state.available) {
        return false;
      }
      sendingRef.current = true;
      lastMessageRef.current = text;
      setDraft("");
      dispatch({ type: "user_sent", text });
      void stream(text);
      return true;
    },
    [state.available, stream],
  );

  const send = useCallback(() => {
    sendText(draft);
  }, [draft, sendText]);

  useEffect(() => {
    const onPrefill = (e: Event) => {
      const { text, send: autoSend } = (e as CustomEvent<ChatPrefill>).detail;
      if (autoSend && state.loaded && sendText(text)) return;
      setDraft(text);
    };
    window.addEventListener(CHAT_PREFILL_EVENT, onPrefill);
    return () => window.removeEventListener(CHAT_PREFILL_EVENT, onPrefill);
  }, [sendText, state.loaded]);

  const retry = useCallback(() => {
    if (sendingRef.current || !lastMessageRef.current) return;
    sendingRef.current = true;
    dispatch({ type: "retry_started" });
    void stream(lastMessageRef.current);
  }, [stream]);

  const confirm = useCallback(
    async (orderId: string, phone: string) => {
      dispatch({ type: "confirm_started", orderId });
      try {
        const res = await fetch(
          `/api/s/${encodeURIComponent(slug)}/orders/${encodeURIComponent(orderId)}/confirm`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(phone.trim() ? { phone: phone.trim() } : {}),
          },
        );
        if (!res.ok) {
          dispatch({
            type: "confirm_failed",
            orderId,
            message: await errorMessage(res, genericError),
          });
          return;
        }
        const view = toOrderView(await res.json());
        if (view) dispatch({ type: "confirm_succeeded", order: view });
        else dispatch({ type: "confirm_failed", orderId, message: genericError });
      } catch {
        dispatch({ type: "confirm_failed", orderId, message: networkError });
      }
    },
    [slug, genericError, networkError],
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
  const lang = lastUserLang(state.items, uiLang);
  const canSend = !disabled && !state.sending && draft.trim() !== "";

  return (
    <div className="chat">
      <div className="chat-head">
        <div className="chat-avatar" aria-hidden="true">
          {initials(storeName)}
        </div>
        <div className="chat-head-text">
          <h2 className="chat-title">{t(uiLang, "assistantTitle", { store: storeName })}</h2>
          <span className="chat-sub">{t(uiLang, fallback ? "subFallback" : "subCatalog")}</span>
        </div>
      </div>

      <div
        className="chat-log"
        role="log"
        aria-live="polite"
        aria-label={t(uiLang, "chatWith", { store: storeName })}
      >
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
            <p>{t(uiLang, "unavailableNotice")}</p>
          </div>
        ) : null}
        {state.loaded && state.items.length === 0 && !disabled ? (
          <div className="chat-empty">
            <p className="chat-note">{t(uiLang, "askInHint")}</p>
            <div className="chat-chips">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.en}
                  type="button"
                  className="chat-chip"
                  disabled={state.sending}
                  onClick={() => sendText(s[uiLang])}
                >
                  {s[uiLang]}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {state.items.map((item) => {
          if (item.kind === "message") {
            return (
              <div key={item.id} className={`chat-bubble chat-bubble-${item.role}`}>
                <span className="sr-only">
                  {item.role === "user" ? t(uiLang, "you") : t(uiLang, "assistant")}
                </span>
                {item.content}
              </div>
            );
          }
          if (item.kind === "offers") {
            return <OfferCards key={item.id} slug={slug} offers={item.offers} lang={uiLang} />;
          }
          if (item.kind === "order") {
            return (
              <OrderSummary
                key={item.id}
                slug={slug}
                order={item.order}
                lang={lang}
                uiLang={uiLang}
                onConfirm={confirm}
              />
            );
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
            <span className="chat-activity">{state.activity ?? UI_LABELS[lang].typing}</span>
          </div>
        ) : null}
        {state.error ? (
          <p className="chat-error" role="alert">
            <span>{state.error.message}</span>
            {state.error.retryable ? (
              <button type="button" className="chat-link" onClick={retry}>
                {t(uiLang, "tryAgain")}
              </button>
            ) : null}
          </p>
        ) : null}
        <div ref={endRef} />
      </div>

      <form className="chat-form" onSubmit={onSubmit}>
        <label htmlFor="chat-input" className="sr-only">
          {t(uiLang, "messageLabel")}
        </label>
        <textarea
          id="chat-input"
          className="chat-input"
          rows={1}
          maxLength={MAX_MESSAGE_CHARS}
          placeholder={disabled ? t(uiLang, "assistantUnavailable") : UI_LABELS[lang].placeholder}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="submit"
          className="chat-send"
          aria-label={t(uiLang, "send")}
          disabled={!canSend}
        >
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
