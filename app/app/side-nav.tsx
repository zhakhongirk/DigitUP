"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

const SECTIONS = [
  {
    title: "Today",
    links: [
      { href: "/app", label: "Workspace", badge: null, exact: true },
      { href: "/app/inbox", label: "Inbox", badge: "inbox" },
      { href: "/app/notifications", label: "Notifications", badge: "notifications" },
      { href: "/app/changes", label: "Change sets", badge: "changes" },
    ],
  },
  {
    title: "Store",
    links: [
      { href: "/app/catalog", label: "Catalog", badge: null },
      { href: "/app/analytics", label: "Analytics", badge: null },
      { href: "/app/settings", label: "Settings", badge: null },
    ],
  },
  {
    title: "Agents",
    links: [
      { href: "/app/agents", label: "Connect agents", badge: null },
      { href: "/app/audit", label: "Audit log", badge: null },
    ],
  },
] as const;

export function SideNav({
  slug,
  counts,
}: {
  slug: string;
  counts: { inbox: number; changes: number; notifications: number };
}) {
  const path = usePathname();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    const active = el?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!el || !active || el.scrollWidth <= el.clientWidth) return;
    el.scrollTo({ left: active.offsetLeft - 16, behavior: "auto" });
  }, [path]);
  return (
    <div className="ws-links" ref={root}>
      {SECTIONS.map((section) => (
        <div key={section.title} className="ws-section" role="group" aria-label={section.title}>
          <span className="ws-section-title" aria-hidden="true">
            {section.title}
          </span>
          {section.links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={
                ("exact" in link ? path === link.href : path.startsWith(link.href))
                  ? "page"
                  : undefined
              }
            >
              {link.label}
              {link.badge && counts[link.badge] > 0 ? (
                <span
                  className={link.badge === "changes" ? "ws-badge ws-badge-warn" : "ws-badge"}
                  aria-label={`${counts[link.badge]} ${link.badge === "changes" ? "pending" : "new"}`}
                >
                  {counts[link.badge]}
                </span>
              ) : null}
            </Link>
          ))}
        </div>
      ))}
      <a href={`/s/${slug}`} target="_blank" rel="noreferrer" className="ws-external">
        View storefront ↗
      </a>
    </div>
  );
}
