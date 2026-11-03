"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const DEBOUNCE_MS = 300;

export function SearchBox({ initial, filter }: { initial: string; filter: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const applied = useRef(initial);

  useEffect(() => {
    const next = value.trim();
    if (next === applied.current) return;
    const timer = setTimeout(() => {
      applied.current = next;
      const params = new URLSearchParams();
      if (filter !== "all") params.set("filter", filter);
      if (next) params.set("q", next);
      const query = params.toString();
      router.replace(query ? `/app/inbox?${query}` : "/app/inbox");
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value, filter, router]);

  return (
    <label className="field ib-search">
      <span className="sr-only">Search the inbox</span>
      <input
        type="search"
        inputMode="search"
        value={value}
        maxLength={80}
        placeholder="Search name, phone or order number"
        onChange={(event) => setValue(event.target.value)}
      />
    </label>
  );
}
