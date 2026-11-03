import Link from "next/link";
import { LangSwitch } from "@/app/lang-switch";
import { ownerT } from "@/server/owner/lang";
import "./landing.css";

export default async function HomePage() {
  const { t, lang } = await ownerT();

  const steps = [
    ["1", t("lp.step1"), "/onboarding", t("lp.step1Text")],
    ["2", t("lp.step2"), "/onboarding/review", t("lp.step2Text")],
    ["3", t("lp.step3"), "/s/:slug", t("lp.step3Text")],
  ] as const;

  const workspace = [
    [t("nav.inbox"), "/app/inbox", t("lp.wsInbox")],
    [t("nav.approvals"), "/app/approvals", t("lp.wsApprovals")],
    [t("nav.catalog"), "/app/catalog", t("lp.wsCatalog")],
    [t("nav.analytics"), "/app/analytics", t("lp.wsAnalytics")],
    [t("nav.audit"), "/app/audit", t("lp.wsAudit")],
  ] as const;

  const endpoints = [
    ["MCP", t("lp.epPublic"), "/mcp/public/:slug", t("lp.epPublicText")],
    ["MCP", t("lp.epCustomer"), "/mcp/customer/:slug", t("lp.epCustomerText")],
    ["MCP", t("lp.epBusiness"), "/mcp/business", t("lp.epBusinessText")],
  ] as const;

  const demos = [
    ["Stride Shoes", "/s/stride-shoes", t("lp.demoShoes")],
    ["Fade Factory", "/s/fade-factory", t("lp.demoBarber")],
  ] as const;

  const principles = [
    [t("lp.p1"), t("lp.p1Text")],
    [t("lp.p2"), t("lp.p2Text")],
    [t("lp.p3"), t("lp.p3Text")],
    [t("lp.p4"), t("lp.p4Text")],
  ] as const;

  return (
    <main className="lp-root">
      <header className="lp-top">
        <Link href="/" className="ln-logo">
          <span className="ln-logo-mark" aria-hidden="true">
            AS
          </span>
          {t("auth.brand")}
        </Link>
        <span className="lp-top-actions">
          <LangSwitch lang={lang} />
          <Link href="/signin" className="btn btn-sm btn-secondary">
            {t("lp.signIn")}
          </Link>
        </span>
      </header>

      <section className="lp-hero">
        <h1>{t("lp.heroTitle")}</h1>
        <p>{t("lp.heroBody")}</p>
        <div className="lp-actions">
          <Link href="/onboarding" className="btn">
            {t("lp.create")}
          </Link>
        </div>
      </section>

      <section className="lp-group" aria-labelledby="lp-how">
        <h2 id="lp-how" className="lp-label">
          {t("lp.how")}
        </h2>
        <div className="lp-grid">
          {steps.map(([n, title, route, text]) => (
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
          {t("lp.workspace")}
        </h2>
        <div className="lp-grid">
          {workspace.map(([title, route, text]) => (
            <div key={route} className="lp-card glass">
              <h3>{title}</h3>
              <code className="lp-route">{route}</code>
              <p>{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="lp-group" aria-labelledby="lp-agents">
        <h2 id="lp-agents" className="lp-label">
          {t("lp.agents")}
        </h2>
        <div className="lp-grid">
          {endpoints.map(([kicker, title, route, text]) => (
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
          {t("lp.demo")}
        </h2>
        <div className="lp-grid">
          {demos.map(([title, route, text]) => (
            <Link key={route} href={route} className="lp-card lp-card-link glass">
              <h3>{title}</h3>
              <code className="lp-route">{route}</code>
              <p>{text}</p>
            </Link>
          ))}
        </div>
      </section>

      <section className="lp-principles" aria-label={t("lp.principles")}>
        {principles.map(([title, text]) => (
          <div key={title}>
            <b>{title}</b>
            <p>{text}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
