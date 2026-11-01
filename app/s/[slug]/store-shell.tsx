"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";

type Props = { main: ReactNode; chat: ReactNode };

export function StoreShell({ main, chat }: Props) {
  const [tab, setTab] = useState<"shop" | "chat">("shop");

  // Links to the chat switch to it on narrow screens and focus the message box.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.("a[href='#store-chat']");
      if (!link) return;
      e.preventDefault();
      setTab("chat");
      requestAnimationFrame(() => document.getElementById("chat-input")?.focus());
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  return (
    <>
      <div className="sf-body" data-tab={tab}>
        <div className="sf-main">{main}</div>
        <aside id="store-chat" className="sf-chat glass" aria-label="Store assistant">
          {chat}
        </aside>
      </div>
      <nav className="sf-tabbar glass" aria-label="Store sections">
        <button
          type="button"
          className="sf-tab"
          aria-pressed={tab === "shop"}
          onClick={() => setTab("shop")}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden="true"
          >
            <rect x="4" y="4" width="7" height="7" rx="2" />
            <rect x="13" y="4" width="7" height="7" rx="2" />
            <rect x="4" y="13" width="7" height="7" rx="2" />
            <rect x="13" y="13" width="7" height="7" rx="2" />
          </svg>
          Shop
        </button>
        <button
          type="button"
          className="sf-tab"
          aria-pressed={tab === "chat"}
          onClick={() => setTab("chat")}
        >
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
          Chat
        </button>
      </nav>
    </>
  );
}
