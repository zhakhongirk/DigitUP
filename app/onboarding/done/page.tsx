import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { appBaseUrl } from "@/server/owner/base-url";
import { ownerMeta, ownerT } from "@/server/owner/lang";
import { currentOwner } from "@/server/owner/session";
import { OnboardingHeader } from "../header";
import { CopyButton } from "./copy-button";
import { KeyPanel } from "./key-panel";
import { LiveWait } from "./live-wait";
import "../onboarding.css";

export const dynamic = "force-dynamic";
export const generateMetadata = (): Promise<Metadata> => ownerMeta("dn.pageTitle");

const TOOLS = [
  "search_offers",
  "get_offer_details",
  "check_availability",
  "compare_offers",
  "get_business_info",
  "create_order",
  "submit_inquiry",
] as const;

export default async function DonePage() {
  const services = await getServices();
  const [{ t, tn }, owner] = await Promise.all([ownerT(), currentOwner(services)]);
  if (!owner) redirect("/signin?next=/onboarding/done");

  const [tenant, draft] = await Promise.all([
    services.tenancy.getTenant(owner),
    services.catalog.getLatestDraft(owner),
  ]);

  if (tenant.status !== "live") {
    if (draft?.status !== "confirmed") redirect("/onboarding");
    return (
      <main className="ob-root">
        <OnboardingHeader step={3} />
        <section className="ob-panel glass" aria-live="polite">
          <div className="ob-progress-head">
            <b>{t("dn.launching", { name: tenant.name })}</b>
            <LiveWait />
          </div>
          <p className="ob-hint">{t("dn.launchingBody")}</p>
        </section>
      </main>
    );
  }

  const model = await services.catalog.getBusinessModel(owner);
  const base = await appBaseUrl();
  const storeUrl = `${base}/s/${tenant.slug}`;
  const publicUrl = `${base}/mcp/public/${tenant.slug}`;
  const customerUrl = `${base}/mcp/customer/${tenant.slug}`;
  const offers = model.offers.length;
  const open = model.missing_info.length;

  const cards = [
    {
      who: t("dn.forCustomers"),
      title: t("dn.storefront"),
      text: t("dn.storefrontText"),
      url: storeUrl,
      href: `/s/${tenant.slug}`,
      cta: t("dn.openStorefront"),
      primary: true,
    },
    {
      who: t("dn.forYou"),
      title: t("dn.workspace"),
      text: t("dn.workspaceText"),
      url: `${base}/app`,
      href: "/app",
      cta: t("dn.openWorkspace"),
      primary: false,
    },
    {
      who: t("dn.forAgents"),
      title: t("dn.endpoint"),
      text: t("dn.endpointText"),
      url: publicUrl,
      href: "#connect",
      cta: t("dn.setupBelow"),
      primary: false,
    },
  ];

  return (
    <main className="ob-root ob-root-done">
      <OnboardingHeader step={3} />
      <div className="ob-hero-done">
        <span className="ob-done-mark" aria-hidden="true">
          <svg
            width="30"
            height="30"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
          >
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        </span>
        <div className="ob-intro">
          <h1>{t("dn.live", { name: tenant.name })}</h1>
          <p>
            {tn("dn.published", offers)}
            {open > 0 ? tn("dn.openQuestions", open) : ""}
          </p>
        </div>
      </div>

      <div className="ob-cards">
        {cards.map((card) => (
          <section key={card.title} className="ob-card glass">
            <span className="ob-kicker">{card.who}</span>
            <h2>{card.title}</h2>
            <p>{card.text}</p>
            <div className="ob-copy-row">
              <code>{card.url}</code>
              <CopyButton text={card.url} />
            </div>
            <Link href={card.href} className={card.primary ? "btn" : "btn btn-secondary"}>
              {card.cta}
            </Link>
          </section>
        ))}
      </div>

      <section
        id="connect"
        className="ob-panel ob-connect-panel glass"
        aria-labelledby="ob-connect-title"
      >
        <div className="ob-intro">
          <h2 id="ob-connect-title">{t("dn.connect")}</h2>
          <p className="ob-hint">{t("dn.connectBody")}</p>
        </div>
        <div className="ob-connect">
          <KeyPanel slug={tenant.slug} publicUrl={publicUrl} customerUrl={customerUrl} />
          <div className="ob-connect-steps">
            <b>{t("dn.toolsOn", { slug: tenant.slug })}</b>
            <ul className="ob-tools">
              {TOOLS.map((name) => (
                <li key={name}>
                  <code>{name}</code>
                  <span>{t(`dn.tool.${name}` as const)}</span>
                </li>
              ))}
            </ul>
            <span className="ob-hint">{t("dn.businessHint", { path: "/mcp/business" })}</span>
            <span className="ob-hint">{t("dn.try", { name: tenant.name })}</span>
          </div>
        </div>
      </section>
    </main>
  );
}
