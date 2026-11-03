import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { pendingChangeCount } from "@/server/owner/changes";
import { newInboxCount } from "@/server/owner/inbox";
import { currentOwner } from "@/server/owner/session";
import { signOut } from "./actions";
import { SideNav } from "./side-nav";
import "./app.css";

export const dynamic = "force-dynamic";

function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words.slice(0, 2).map((w) => w[0]) : [...name.slice(0, 2)];
  return letters.join("").toUpperCase();
}

export default async function OwnerLayout({ children }: { children: ReactNode }) {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app");

  const tenant = await services.tenancy.getTenant(owner);
  if (tenant.status !== "live") redirect("/onboarding");
  const [inbox, changes] = await Promise.all([
    newInboxCount(services, owner),
    pendingChangeCount(services, owner),
  ]);

  return (
    <div className="ws-root">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <nav className="ws-nav glass" aria-label="Workspace">
        <div className="ws-brand">
          <span className="ws-mark" aria-hidden="true">
            {initials(tenant.name)}
          </span>
          <div>
            <b>{tenant.name}</b>
            <span>Owner</span>
          </div>
          <form action={signOut} className="ws-signout">
            <button type="submit" aria-label="Sign out" title="Sign out">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <path d="M16 17l5-5-5-5M21 12H9" />
              </svg>
            </button>
          </form>
        </div>
        <SideNav slug={tenant.slug} counts={{ inbox, changes }} />
      </nav>
      <main id="main" tabIndex={-1} className="ws-main">
        {children}
      </main>
    </div>
  );
}
