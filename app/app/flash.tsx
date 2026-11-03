"use client";

import { useEffect, useState, type ReactNode } from "react";

export function Flash({
  children,
  tone = "ok",
  duration = 4000,
}: {
  children: ReactNode;
  tone?: "ok" | "warn";
  duration?: number;
}) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), duration);
    return () => clearTimeout(timer);
  }, [duration]);
  if (!visible) return null;
  return <span className={`chip chip-${tone} flash`}>{children}</span>;
}
