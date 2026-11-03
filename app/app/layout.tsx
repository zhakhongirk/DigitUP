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
  const [inbox, changes, notifications] = await Promise.all([
    newInboxCount(services, owner),
    pendingChangeCount(services, owner),
    services.notifications.unreadCount(owner),
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
        </div>
        <SideNav slug={tenant.slug} counts={{ inbox, changes, notifications }} />
        <form action={signOut} className="ws-signout">
          <button type="submit">Sign out</button>
        </form>
      </nav>
      <main id="main" tabIndex={-1} className="ws-main">
        {children}
      </main>
    </div>
  );
}
