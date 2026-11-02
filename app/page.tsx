import Link from "next/link";
import "./onboarding/onboarding.css";

const POINTS = [
  ["Bring what you have", "Price lists, catalogs and policies in XLSX, CSV, PDF or Word."],
  [
    "Review, then launch",
    "The Business Agent drafts your catalog. Nothing goes live until you confirm it.",
  ],
  [
    "Sell to people and agents",
    "A storefront with a store assistant, plus an MCP endpoint other AI agents can use.",
  ],
] as const;

export default function HomePage() {
  return (
    <main className="ob-root">
      <div className="ob-top">
        <Link href="/" className="ob-logo">
          <span className="ob-logo-mark" aria-hidden="true">
            AS
          </span>
          Agentic Storefront
        </Link>
        <Link href="/signin" className="btn btn-sm btn-secondary">
          Sign in
        </Link>
      </div>
      <div className="ob-intro">
        <h1>Your store, run by agents you control.</h1>
        <p>
          Turn the files you already have into a storefront with a store assistant that answers
          shoppers and their AI agents, without inventing a single price.
        </p>
      </div>
      <div className="ob-cards">
        {POINTS.map(([title, text]) => (
          <section key={title} className="ob-card glass">
            <h2>{title}</h2>
            <p>{text}</p>
          </section>
        ))}
      </div>
      <div className="ob-actions-buttons">
        <Link href="/onboarding" className="btn">
          Set up a store
        </Link>
        <Link href="/s/stride-shoes" className="btn btn-secondary">
          See a demo store
        </Link>
      </div>
    </main>
  );
}
