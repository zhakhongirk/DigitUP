"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useT } from "@/app/i18n-provider";
import type { LiveItem, LivePulse } from "@/server/owner/inbox";

export const POLL_MS = 15_000;
const TOAST_MS = 9_000;
const MAX_TOASTS = 3;

interface Counts {
  inbox: number;
  changes: number;
}

const LiveContext = createContext<Counts>({ inbox: 0, changes: 0 });

export function useLiveCounts(): Counts {
  return useContext(LiveContext);
}

export function LiveProvider({ initial, children }: { initial: Counts; children: ReactNode }) {
  const { t } = useT();
  const router = useRouter();
  const path = usePathname();
  const [counts, setCounts] = useState<Counts>(initial);
  const [toasts, setToasts] = useState<LiveItem[]>([]);
  const since = useRef(0);
  const busy = useRef(false);
  const shown = useRef(new Set<string>());
  const onInbox = useRef(false);
  const [seen, setSeen] = useState(initial);
  if (seen.inbox !== initial.inbox || seen.changes !== initial.changes) {
    setSeen(initial);
    setCounts(initial);
  }

  useEffect(() => {
    onInbox.current = path.startsWith("/app/inbox");
  }, [path]);

  const poll = useCallback(async () => {
    if (busy.current || document.visibilityState !== "visible") return;
    busy.current = true;
    try {
      const response = await fetch(`/app/live?since=${since.current}`, { cache: "no-store" });
      if (!response.ok) return;
      const pulse = (await response.json()) as LivePulse;
      setCounts({ inbox: pulse.inbox, changes: pulse.changes });
      since.current = pulse.now;
      const fresh = pulse.items.filter((item) => !shown.current.has(item.key));
      if (fresh.length > 0) {
        for (const item of fresh) shown.current.add(item.key);
        setToasts((current) => [...current, ...fresh].slice(-MAX_TOASTS));
        if (onInbox.current) router.refresh();
      }
    } catch {
      return;
    } finally {
      busy.current = false;
    }
  }, [router]);

  useEffect(() => {
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [poll]);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setTimeout(() => setToasts((current) => current.slice(1)), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toasts]);

  return (
    <LiveContext.Provider value={counts}>
      {children}
      <div className="ws-toasts" role="status" aria-live="polite">
        {toasts.map((item) => (
          <div key={item.key} className="ws-toast glass">
            <span>
              {item.kind === "order"
                ? t("live.newOrder", { name: item.who })
                : t("live.newQuestionFrom", { name: item.who })}
            </span>
            <Link href={`/app/inbox?item=${encodeURIComponent(item.key)}#detail`}>
              {t("live.open")}
            </Link>
            <button
              type="button"
              aria-label={t("live.close")}
              onClick={() => setToasts((current) => current.filter((x) => x.key !== item.key))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </LiveContext.Provider>
  );
}
