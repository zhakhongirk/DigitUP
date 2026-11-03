import Link from "next/link";
import "./landing.css";

const STEPS = [
  ["1", "Upload", "/onboarding", "Price lists, catalogs and policies as XLSX, CSV, PDF or Word."],
  [
    "2",
    "Review",
    "/onboarding/review",
    "A draft business model: profile, offers, policies and what is still missing.",
  ],
  [
    "3",
    "Go live",
    "/s/:slug",
    "A storefront with a store assistant, plus MCP endpoints for AI agents.",
  ],
] as const;

const WORKSPACE = [
  ["Inbox", "/app/inbox", "Orders and shopper questions the assistant could not answer."],
  [
    "Approvals",
    "/app/approvals",
    "Price changes, deletions and bulk edits from agents wait for your approval.",
  ],
  ["Catalog", "/app/catalog", "Edit offers, prices and policies after launch."],
  ["Analytics", "/app/analytics", "See what shoppers and agents ask for."],
  ["Audit log", "/app/audit", "Every change to the store, and who made it."],
] as const;

const ENDPOINTS = [
  ["MCP", "Public", "/mcp/public/:slug", "No key. Talk to the store assistant."],
  [
    "MCP",
    "Customer Agent",
    "/mcp/customer/:slug",
    "Customer Agent key. Search offers, check stock, place orders.",
  ],
  ["MCP", "Business agent", "/mcp/business", "Owner key. Manage the catalog and review approvals."],
] as const;

const DEMOS = [
  ["Stride Shoes", "/s/stride-shoes", "A shoe store with prices on request and a chat."],
  ["Fade Factory", "/s/fade-factory", "A barbershop with bookable services."],
] as const;

const PRINCIPLES = [
  ["No invented prices or stock", "Missing facts stay missing and show as to be confirmed."],
  ["The buyer confirms", "An agent can draft an order, but only the buyer makes it final."],
  ["Risky edits need approval", "Price changes and deletions wait for the owner."],
  ["Order lifecycle", "Every order moves through clear statuses you can follow."],
] as const;

export default function HomePage() {
  return (
    <main className="lp-root">
      <header className="lp-top">
        <Link href="/" className="ln-logo">
          <span className="ln-logo-mark" aria-hidden="true">
            AS
          </span>
          Agentic Storefront
        </Link>
        <Link href="/signin" className="btn btn-sm btn-secondary">
          Sign in
        </Link>
      </header>

      <section className="lp-hero">
        <h1>Your price lists, as a store that talks.</h1>
        <p>
          Upload the files you already have. Review the business model drafted from them, then
          launch a storefront. Shoppers get a store assistant, and other agents get MCP endpoints.
          Nothing is invented: missing prices stay missing.
        </p>
        <div className="lp-actions">
          <Link href="/onboarding" className="btn">
            Create your store
          </Link>
        </div>
      </section>

      <section className="lp-group" aria-labelledby="lp-how">
        <h2 id="lp-how" className="lp-label">
          How it works
        </h2>
        <div className="lp-grid">
          {STEPS.map(([n, title, route, text]) => (
            <div key={n} className="lp-card glass">
              <span className="lp-num">{n}</span>
              <h3>{title}</h3>
              <code className="lp-route">{route}</code>
              <p>{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="lp-group" aria-labelledby="lp-workspace">
        <h2 id="lp-workspace" className="lp-label">
          Your workspace
        </h2>
        <div className="lp-grid">
          {WORKSPACE.map(([title, route, text]) => (
            <div key={title} className="lp-card glass">
              <h3>{title}</h3>
              <code className="lp-route">{route}</code>
              <p>{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="lp-group" aria-labelledby="lp-agents">
        <h2 id="lp-agents" className="lp-label">
          For AI agents
        </h2>
        <div className="lp-grid">
          {ENDPOINTS.map(([kicker, title, route, text]) => (
            <div key={route} className="lp-card glass">
              <span className="lp-num">{kicker}</span>
              <h3>{title}</h3>
              <code className="lp-route">{route}</code>
              <p>{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="lp-group" aria-labelledby="lp-demo">
        <h2 id="lp-demo" className="lp-label">
          Try a demo store
        </h2>
        <div className="lp-grid">
          {DEMOS.map(([title, route, text]) => (
            <Link key={route} href={route} className="lp-card lp-card-link glass">
              <h3>{title}</h3>
              <code className="lp-route">{route}</code>
              <p>{text}</p>
            </Link>
          ))}
        </div>
      </section>

      <section className="lp-principles" aria-label="Principles">
        {PRINCIPLES.map(([title, text]) => (
          <div key={title}>
            <b>{title}</b>
            <p>{text}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
