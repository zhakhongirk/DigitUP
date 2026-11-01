import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { getServices } from "@/server/container";
import { loadStore } from "@/server/storefront/data";
import { ChatPanel } from "./chat-panel";
import { StoreShell } from "./store-shell";
import "./storefront.css";

export const dynamic = "force-dynamic";

type Props = { children: ReactNode; params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { slug } = await params;
  const store = await loadStore(await getServices(), slug);
  if (!store) return { title: "Store not found" };
  return {
    title: { default: store.name, template: `%s | ${store.name}` },
    description: store.description || undefined,
  };
}

const CONTACT_LABELS: [string, string][] = [
  ["phone", "Phone"],
  ["email", "Email"],
  ["whatsapp", "WhatsApp"],
  ["telegram", "Telegram"],
  ["instagram", "Instagram"],
  ["website", "Website"],
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
  const store = await loadStore(await getServices(), slug);
  // Unknown store: render the child (which calls notFound) without store chrome.
  if (!store) return <div className="sf-root">{children}</div>;

  const contacts = CONTACT_LABELS.flatMap(([key, label]) => {
    const value = store.contacts[key as keyof typeof store.contacts];
    return value ? [{ key, label, value }] : [];
  });
  const address = store.contacts.address;

  const policies =
    store.policies.length > 0 ? (
      <section className="sf-policies glass" aria-labelledby="sf-policies-title">
        <h2 id="sf-policies-title">Store policies</h2>
        <dl>
          {store.policies.map((p) => (
            <div key={p.key} className="sf-policy">
              <dt>{p.label}</dt>
              <dd className={p.text === "To be confirmed" ? "sf-policy-tbc" : undefined}>
                {p.text}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    ) : null;

  return (
    <div className="sf-root">
      <header className="sf-header glass">
        <Link href={`/s/${slug}`} className="sf-mark" aria-label={`${store.name} home`}>
          {initials(store.name)}
        </Link>
        <div className="sf-brand">
          <Link href={`/s/${slug}`} className="sf-brand-name">
            {store.name}
          </Link>
          {address ? <span className="sf-brand-sub">{address}</span> : null}
        </div>
        {contacts.length > 0 ? (
          <ul className="sf-contacts" aria-label="Contacts">
            {contacts.map((c) => (
              <li key={c.key}>
                <span className="sr-only">{c.label}: </span>
                {contactValue(c.key, c.value)}
              </li>
            ))}
          </ul>
        ) : null}
      </header>

      <StoreShell
        main={
          <>
            {children}
            {policies}
          </>
        }
        chat={<ChatPanel slug={slug} storeName={store.name} />}
      />
    </div>
  );
}
