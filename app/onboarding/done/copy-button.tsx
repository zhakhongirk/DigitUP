"use client";

import { useState } from "react";
import { useT } from "@/app/i18n-provider";

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm btn-secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? t("common.copied") : (label ?? t("common.copy"))}
    </button>
  );
}
