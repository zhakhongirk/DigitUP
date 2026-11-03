import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { appBaseUrl } from "@/server/owner/base-url";
import { formatWhen } from "@/server/owner/inbox";
import { ownerMeta, ownerT } from "@/server/owner/lang";
import { currentOwner } from "@/server/owner/session";
import { CopyButton } from "@/app/onboarding/done/copy-button";
import { KeyCreate } from "./key-create";
import { RevokeButton } from "./revoke-button";
import "./agents.css";

export const dynamic = "force-dynamic";
export const generateMetadata = (): Promise<Metadata> => ownerMeta("nav.agents");

const KIND_KEYS = {
  customer_agent: "ag.kindCustomer",
  owner: "ag.kindOwner",
} as const;

const CUSTOMER_TOOLS = [
  "search_offers",
  "get_offer_details",
  "check_availability",
  "compare_offers",
  "get_business_info",
  "create_order",
  "submit_inquiry",
  "get_inquiry",
];

const BUSINESS_TOOLS = [
  "get_business_model",
  "search_offers",
  "list_source_assets",
  "propose_business_model",
  "confirm_business_model",
  "upsert_offers",
  "update_prices",
  "update_offer_types",
  "update_policies",
  "delete_offers",
  "list_orders",
  "get_order",
  "update_order_status",
  "list_inquiries",
  "get_inquiry",
  "update_inquiry_status",
  "list_conversations",
  "get_conversation",
  "list_change_sets",
  "approve_change_set",
  "reject_change_set",
];

export default async function AgentsPage() {
  const services = await getServices();
  const [{ t, lang }, owner] = await Promise.all([ownerT(), currentOwner(services)]);
  if (!owner) redirect("/signin?next=/app/agents");

  const [tenant, keys, base] = await Promise.all([
    services.tenancy.getTenant(owner),
    services.tenancy.listApiKeys(owner),
    appBaseUrl(),
  ]);
  const publicUrl = `${base}/mcp/public/${tenant.slug}`;
  const customerUrl = `${base}/mcp/customer/${tenant.slug}`;
  const businessUrl = `${base}/mcp/business`;
  const now = new Date();

  const endpoints = [
    {
      title: t("ag.pubTitle"),
      auth: t("ag.pubAuth"),
      text: t("ag.pubText"),
      who: t("ag.pubWho"),
      url: publicUrl,
      tools: ["talk_to_store"],
    },
    {
      title: t("ag.cusTitle"),
      auth: t("ag.cusAuth"),
      text: t("ag.cusText"),
      who: t("ag.cusWho"),
      url: customerUrl,
      tools: CUSTOMER_TOOLS,
    },
    {
      title: t("ag.bizTitle"),
      auth: t("ag.bizAuth"),
      text: t("ag.bizText"),
      who: t("ag.bizWho"),
      url: businessUrl,
      tools: BUSINESS_TOOLS,
    },
  ];

  return (
    <>
      <div className="ws-title">
        <h1>{t("ag.title")}</h1>
        <p className="ws-sub">{t("ag.sub", { store: tenant.name })}</p>
      </div>

      <div className="ag-endpoints">
        {endpoints.map((endpoint) => (
          <section key={endpoint.title} className="ag-card glass">
            <div className="ag-card-head">
              <h2>{endpoint.title}</h2>
              <span className="ag-chip">{endpoint.auth}</span>
            </div>
            <p className="ag-text">{endpoint.text}</p>
            <p className="ag-text">{endpoint.who}</p>
            <details>
              <summary>{t("ag.technical")}</summary>
              <p className="ag-hint">{t("ag.addressHint")}</p>
              <div className="ag-copy-row">
                <code>{endpoint.url}</code>
                <CopyButton text={endpoint.url} />
              </div>
              <ul className="ag-tools" aria-label={t("ag.toolsLabel", { title: endpoint.title })}>
                {endpoint.tools.map((tool) => (
                  <li key={tool}>
                    <code>{tool}</code>
                  </li>
                ))}
              </ul>
            </details>
          </section>
        ))}
      </div>

      <section className="ag-keys glass" aria-labelledby="ag-keys-title">
        <div className="ag-keys-head">
          <h2 id="ag-keys-title">{t("ag.keys")}</h2>
          <span className="ag-hint">{t("ag.keysHint")}</span>
        </div>
        <KeyCreate customerUrl={customerUrl} businessUrl={businessUrl} />
        {keys.length === 0 ? (
          <p className="ag-empty">{t("ag.noKeys")}</p>
        ) : (
          <div className="ag-table-wrap">
            <table className="ag-table">
              <thead>
                <tr>
                  <th>{t("ag.colKey")}</th>
                  <th>{t("ag.colType")}</th>
                  <th>{t("ag.colCreated")}</th>
                  <th>{t("ag.colStatus")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id} className={key.revokedAt ? "ag-revoked" : undefined}>
                    <td>
                      <code>{key.prefix}…</code>
                    </td>
                    <td>
                      {key.kind in KIND_KEYS
                        ? t(KIND_KEYS[key.kind as keyof typeof KIND_KEYS])
                        : key.kind}
                    </td>
                    <td>{formatWhen(key.createdAt, now, undefined, lang)}</td>
                    <td>
                      {key.revokedAt ? (
                        <span className="ag-chip ag-chip-revoked">{t("ag.revoked")}</span>
                      ) : (
                        <span className="ag-chip ag-chip-active">{t("ag.active")}</span>
                      )}
                    </td>
                    <td className="ag-act">
                      {key.revokedAt ? null : <RevokeButton id={key.id} prefix={key.prefix} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
