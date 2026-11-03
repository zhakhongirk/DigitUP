import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { appBaseUrl } from "@/server/owner/base-url";
import { currentOwner } from "@/server/owner/session";
import { OnboardingHeader } from "../header";
import { CopyButton } from "./copy-button";
import { KeyPanel } from "./key-panel";
import { LiveWait } from "./live-wait";
import "../onboarding.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Store launched" };

const TOOLS = [
  ["search_offers", "Find offers by query, category or attributes"],
  ["get_offer_details", "One offer with all attributes"],
  ["check_availability", "Stock as stored; unknown stays unknown"],
  ["compare_offers", "Side by side for two or more offers"],
  ["get_business_info", "Profile, contacts, policies, hours"],
  ["create_order", "Draft order; the buyer confirms it"],
  ["submit_inquiry", "Question to the owner, e.g. a price"],
] as const;

export default async function DonePage() {
  const services = await getServices();
  const owner = await currentOwner(services);
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
            <b>Launching {tenant.name}…</b>
            <LiveWait />
          </div>
          <p className="ob-hint">
            Publishing your catalog and setting up the store assistant. This takes a few seconds.
          </p>
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
      who: "For customers",
      title: "Storefront",
      text: "Catalog, search and the store assistant chat.",
      url: storeUrl,
      href: `/s/${tenant.slug}`,
      cta: "Open storefront",
      primary: false,
    },
    {
      who: "For other AI agents",
      title: "Agent endpoint",
      text: "MCP server scoped to this store only.",
      url: publicUrl,
      href: "#connect",
      cta: "Setup steps below",
      primary: false,
    },
  ];

  return (
    <main className="ob-root ob-root-wide">
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
          <h1>{tenant.name} is live.</h1>
          <p>
            {offers} {offers === 1 ? "offer" : "offers"} published.
            {open > 0
              ? ` ${open} open ${open === 1 ? "question is" : "questions are"} shown to customers as "to be confirmed".`
              : ""}
          </p>
          <p>
            Orders and customer questions arrive in your <Link href="/app/inbox">inbox</Link>.
          </p>
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <Link href="/app" className="btn">
          Go to your workspace
        </Link>
        <Link href={`/s/${tenant.slug}`} className="btn btn-secondary">
          Open storefront
        </Link>
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

      <section id="connect" className="ob-panel glass" aria-labelledby="ob-connect-title">
        <div className="ob-intro">
          <h2 id="ob-connect-title">Connect an AI agent</h2>
          <p className="ob-hint">
            AI assistants can search your catalog, ask you questions and draft orders. A draft only
            becomes an order after the buyer confirms it.
          </p>
        </div>
        <div className="ob-connect">
          <KeyPanel slug={tenant.slug} publicUrl={publicUrl} customerUrl={customerUrl} />
          <div className="ob-connect-steps">
            <b>Tools with a customer-agent key</b>
            <ul className="ob-tools">
              {TOOLS.map(([name, text]) => (
                <li key={name}>
                  <code>{name}</code>
                  <span>{text}</span>
                </li>
              ))}
            </ul>
            <span className="ob-hint">
              Try: &quot;Find something in my size at {tenant.name} and compare two options.&quot;
            </span>
          </div>
        </div>
      </section>
    </main>
  );
}
