"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Refreshes the page until the store is live. */
export function LiveWait() {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(timer);
  }, [router]);
  return <span className="ob-spinner" aria-hidden="true" />;
}
