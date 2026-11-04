import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { pendingChangeCount } from "@/server/owner/changes";
import { newInboxCount } from "@/server/owner/inbox";
import { LangProvider } from "@/app/i18n-provider";
import { LangSwitch } from "@/app/lang-switch";
import { ownerT } from "@/server/owner/lang";
import { currentOwner } from "@/server/owner/session";
import { signOut } from "./actions";
import { LiveProvider } from "./live";
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
  const [{ lang, t }, owner] = await Promise.all([ownerT(), currentOwner(services)]);
  if (!owner) redirect("/signin?next=/app");

  const tenant = await services.tenancy.getTenant(owner);
  if (tenant.status !== "live") redirect("/onboarding");
  const staff = owner.role === "staff";
  const [inbox, changes] = await Promise.all([
    newInboxCount(services, owner),
    staff ? 0 : pendingChangeCount(services, owner),
  ]);

  return (
    <LangProvider lang={lang}>
      <LiveProvider initial={{ inbox, changes }}>
        <div className="ws-root">
          <a href="#main" className="skip-link">
            {t("nav.skip")}
          </a>
          <nav className="ws-nav glass" aria-label={t("nav.workspaceLabel")}>
            <div className="ws-brand">
              <span className="ws-mark" aria-hidden="true">
                {initials(tenant.name)}
              </span>
              <div>
                <b>{tenant.name}</b>
                <span>{t(staff ? "nav.staff" : "nav.owner")}</span>
              </div>
              <form action={signOut} className="ws-signout">
                <button type="submit" aria-label={t("nav.signOut")} title={t("nav.signOut")}>
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
            <SideNav slug={tenant.slug} role={owner.role ?? "owner"} />
            <LangSwitch lang={lang} className="ws-lang" />
          </nav>
          <main id="main" tabIndex={-1} className="ws-main">
            {children}
          </main>
        </div>
      </LiveProvider>
    </LangProvider>
  );
}
