import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { getServices } from "@/server/container";
import { loadStore } from "@/server/storefront/data";
import { ChatPanel } from "./chat-panel";
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
  ["address", "Address"],
];

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

  return (
    <div className="sf-root">
      <header className="sf-header">
        <div className="sf-header-inner">
          <h1 className="sf-store-name">
            <Link href={`/s/${slug}`}>{store.name}</Link>
          </h1>
          {store.description ? <p className="sf-store-desc">{store.description}</p> : null}
          {contacts.length > 0 ? (
            <ul className="sf-contacts" aria-label="Contacts">
              {contacts.map((c) => (
                <li key={c.key}>
                  <span className="sf-contact-label">{c.label}:</span>{" "}
                  {contactValue(c.key, c.value)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </header>

      <div className="sf-layout">
        <main className="sf-content">{children}</main>
        <aside id="store-chat" className="sf-chat" aria-labelledby="store-chat-title">
          <h2 id="store-chat-title">Store assistant</h2>
          <ChatPanel slug={slug} storeName={store.name} />
        </aside>
      </div>

      <footer className="sf-footer">
        <h2>Store policies</h2>
        <dl className="sf-policies">
          {store.policies.map((p) => (
            <div key={p.key} className="sf-policy">
              <dt>{p.label}</dt>
              <dd>{p.text}</dd>
            </div>
          ))}
        </dl>
      </footer>
    </div>
  );
}
