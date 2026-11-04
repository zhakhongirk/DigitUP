"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { useT } from "@/app/i18n-provider";
import { useLiveCounts } from "./live";
import type { TextKey } from "@/shared/owner-copy";
import { canAccessPath, type UserRole } from "@/shared/staff-access";

const SECTIONS = [
  {
    label: "nav.main",
    links: [
      { href: "/app", label: "nav.workspace", badge: null, exact: true },
      { href: "/app/inbox", label: "nav.inbox", badge: "inbox" },
      { href: "/app/approvals", label: "nav.approvals", badge: "changes" },
      { href: "/app/analytics", label: "nav.analytics", badge: null },
      { href: "/app/audit", label: "nav.audit", badge: null },
    ],
  },
  {
    label: "nav.store",
    links: [
      { href: "/app/catalog", label: "nav.catalog", badge: null },
      { href: "/app/settings", label: "nav.settings", badge: null },
      { href: "/app/agents", label: "nav.agents", badge: null },
    ],
  },
] as const satisfies readonly {
  label: TextKey;
  links: readonly {
    href: string;
    label: TextKey;
    badge: "inbox" | "changes" | null;
    exact?: true;
  }[];
}[];

export function SideNav({ slug, role }: { slug: string; role: UserRole }) {
  const { t } = useT();
  const counts = useLiveCounts();
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
      {SECTIONS.map((section) => ({
        section,
        links: section.links.filter((link) => canAccessPath(role, link.href)),
      }))
        .filter(({ links }) => links.length > 0)
        .map(({ section, links }) => (
          <div
            key={section.label}
            className="ws-section"
            role="group"
            aria-label={t(section.label)}
          >
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={
                  ("exact" in link ? path === link.href : path.startsWith(link.href))
                    ? "page"
                    : undefined
                }
              >
                {t(link.label)}
                {link.badge && counts[link.badge] > 0 ? (
                  <span
                    className={link.badge === "changes" ? "ws-badge ws-badge-warn" : "ws-badge"}
                    aria-label={t(link.badge === "changes" ? "nav.badgePending" : "nav.badgeNew", {
                      n: counts[link.badge],
                    })}
                  >
                    {counts[link.badge]}
                  </span>
                ) : null}
              </Link>
            ))}
          </div>
        ))}
      <a href={`/s/${slug}`} target="_blank" rel="noreferrer" className="ws-external">
        {t("nav.storefront")}
      </a>
    </div>
  );
}
