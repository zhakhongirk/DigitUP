import type { Metadata } from "next";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { getServices } from "@/server/container";
import { appBaseUrl } from "@/server/owner/base-url";
import { loadStore } from "@/server/storefront/data";
import { t } from "@/server/storefront/i18n";
import { buildPageMeta, storePath } from "@/server/storefront/seo";
import { ChatPanel } from "./chat-panel";
import { HeaderSearch } from "./header-search";
import { policyLabel } from "./labels";
import { storefrontLang } from "./lang";
import { stripPolicyLabel } from "./policy";
import { StoreShell } from "./store-shell";
import "./storefront.css";

export const dynamic = "force-dynamic";

type Props = { children: ReactNode; params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { slug } = await params;
  const store = await loadStore(await getServices(), slug);
  if (!store) return { title: "Store not found" };
  const meta = buildPageMeta({
    title: store.name,
    description: store.description,
    path: storePath(slug),
    baseUrl: await appBaseUrl(),
    siteName: store.name,
  });
  return { ...meta, title: { default: store.name, template: `%s | ${store.name}` } };
}

const CONTACT_LABELS: [string, string, string][] = [
  ["phone", "Phone", "Телефон"],
  ["email", "Email", "Email"],
  ["whatsapp", "WhatsApp", "WhatsApp"],
  ["telegram", "Telegram", "Telegram"],
  ["instagram", "Instagram", "Instagram"],
  ["website", "Website", "Сайт"],
];

function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => Array.from(w)[0] ?? "");
  return letters.join("").toUpperCase() || "S";
}

function contactValue(key: string, value: string): ReactNode {
  if (key === "phone") return <a href={`tel:${value.replace(/[^\d+]/g, "")}`}>{value}</a>;
  if (key === "email") return <a href={`mailto:${value}`}>{value}</a>;
  if (key === "website" && /^https?:\/\//i.test(value)) return <a href={value}>{value}</a>;
  return value;
}

export default async function StoreLayout({ children, params }: Props) {
  const { slug } = await params;
  const lang = await storefrontLang();
  const store = await loadStore(await getServices(), slug);
  // Unknown store: render the child (which calls notFound) without store chrome.
  if (!store) {
    return (
      <div className="sf-root" lang={lang}>
        {children}
      </div>
    );
  }

  const contacts = CONTACT_LABELS.flatMap(([key, en, ru]) => {
    const value = store.contacts[key as keyof typeof store.contacts];
    return value ? [{ key, label: lang === "ru" ? ru : en, value }] : [];
  });
  const address = store.contacts.address;

  const tbc = (text: string) => text === "To be confirmed";
  const hours = store.policies.find((p) => p.key === "working_hours");
  const hoursText =
    hours && !tbc(hours.text) ? stripPolicyLabel(hours.key, hours.label, hours.text) : null;
  const sub = [address, hoursText].filter(Boolean).join(" · ");

  const info =
    store.policies.length > 0 || contacts.length > 0 ? (
      <section id="sf-policies" className="sf-policies glass" aria-labelledby="sf-policies-title">
        <h2 id="sf-policies-title">{t(lang, "storeInfo")}</h2>
        <dl>
          {contacts.map((c) => (
            <div key={c.key} className="sf-policy">
              <dt>{c.label}</dt>
              <dd>{contactValue(c.key, c.value)}</dd>
            </div>
          ))}
          {store.policies.map((p) => (
            <div key={p.key} className="sf-policy">
              <dt>{policyLabel(lang, p.key, p.label)}</dt>
              <dd className={tbc(p.text) ? "sf-policy-tbc" : undefined}>
                {tbc(p.text) ? t(lang, "toBeConfirmed") : stripPolicyLabel(p.key, p.label, p.text)}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    ) : null;

  return (
    <div className="sf-root" lang={lang}>
      <header className="sf-header glass">
        <Link
          href={`/s/${slug}`}
          className="sf-mark"
          aria-label={t(lang, "home", { store: store.name })}
        >
          {initials(store.name)}
        </Link>
        <div className="sf-brand">
          <Link href={`/s/${slug}`} className="sf-brand-name">
            {store.name}
          </Link>
          {sub ? <span className="sf-brand-sub">{sub}</span> : null}
        </div>
        <Link href={`/s/${slug}/my-order`} className="sf-brand-sub">
          {t(lang, "myOrder")}
        </Link>
        <Suspense fallback={null}>
          <HeaderSearch
            action={`/s/${slug}`}
            label={t(lang, "searchCatalog")}
            placeholder={t(lang, "searchPlaceholder")}
          />
        </Suspense>
      </header>

      <StoreShell
        lang={lang}
        main={
          <>
            {children}
            {info}
          </>
        }
        chat={<ChatPanel slug={slug} storeName={store.name} lang={lang} />}
      />
    </div>
  );
}
