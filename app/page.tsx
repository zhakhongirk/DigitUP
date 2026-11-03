import Link from "next/link";
import "./landing.css";

const STEPS = [
  ["1", "Upload", "Price lists, catalogs and policies as XLSX, CSV, PDF or Word."],
  ["2", "Review", "A draft business model: profile, offers, policies and what is still missing."],
  ["3", "Go live", "A storefront with a store assistant, plus MCP endpoints for AI agents."],
] as const;

const WORKSPACE = [
  ["Inbox", "Orders and shopper questions the assistant could not answer."],
  ["Change sets", "Price changes, deletions and bulk edits from agents wait for your approval."],
  ["Catalog", "Edit offers, prices and policies after launch."],
  ["Analytics", "See what shoppers and agents ask for."],
  ["Audit log", "Every change to the store, and who made it."],
] as const;

const ENDPOINTS = [
  ["/mcp/public/:slug", "No key. Talk to the store assistant."],
  ["/mcp/customer/:slug", "Customer agent key. Search offers, check stock, place orders."],
  ["/mcp/business", "Owner key. Manage the catalog and review change sets."],
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
        <h1>Turn your price lists into a store that talks to people and AI agents.</h1>
        <p>
          Upload the files you already have. Review the business model drafted from them, then
          launch a storefront. Shoppers get a store assistant, and other agents get MCP endpoints.
          Nothing is invented: missing prices stay missing.
        </p>
        <div className="lp-actions">
          <Link href="/onboarding" className="btn">
            Create your store
          </Link>
          <Link href="/signin" className="btn btn-secondary">
            Sign in
          </Link>
        </div>
        <p className="lp-demos">
          Or look around first: <Link href="/s/stride-shoes">Stride Shoes</Link>
          {", "}
          <Link href="/s/fade-factory">Fade Factory</Link>
        </p>
      </section>

      <section className="lp-steps" aria-label="How it works">
        {STEPS.map(([n, title, text]) => (
          <div key={n} className="lp-card glass">
            <span className="lp-num">{n}</span>
            <h2>{title}</h2>
            <p>{text}</p>
          </div>
        ))}
      </section>

      <section className="lp-block">
        <h2>You stay in control</h2>
        <p className="lp-lead">
          The owner workspace is where you run the store and check what agents did.
        </p>
        <div className="lp-grid">
          {WORKSPACE.map(([title, text]) => (
            <div key={title} className="lp-card glass">
              <h3>{title}</h3>
              <p>{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="lp-block">
        <h2>Built for agents too</h2>
        <p className="lp-lead">
          Every store exposes MCP endpoints over HTTP. The store is fixed before any tool runs.
        </p>
        <ul className="lp-endpoints glass">
          {ENDPOINTS.map(([path, text]) => (
            <li key={path}>
              <code>{path}</code>
              <span>{text}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
