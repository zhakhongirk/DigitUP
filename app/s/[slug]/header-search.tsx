"use client";

import { useSearchParams } from "next/navigation";

type Props = { action: string; label: string; placeholder: string };

export function HeaderSearch({ action, label, placeholder }: Props) {
  const params = useSearchParams();
  const query = params.get("q") ?? "";
  const category = params.get("category");
  return (
    <form method="get" action={action} role="search" className="sf-search">
      <label htmlFor="sf-q" className="field">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-4-4" />
        </svg>
        <span className="sr-only">{label}</span>
        <input
          key={query}
          id="sf-q"
          name="q"
          type="search"
          defaultValue={query}
          placeholder={placeholder}
        />
      </label>
      {category ? <input type="hidden" name="category" value={category} /> : null}
      <button type="submit" className="sr-only">
        {label}
      </button>
    </form>
  );
}
