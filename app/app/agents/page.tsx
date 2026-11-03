import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { appBaseUrl } from "@/server/owner/base-url";
import { formatWhen } from "@/server/owner/inbox";
import { currentOwner } from "@/server/owner/session";
import { CopyButton } from "@/app/onboarding/done/copy-button";
import { KeyCreate } from "./key-create";
import { RevokeButton } from "./revoke-button";
import "./agents.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Connect agents" };

const KIND_LABELS: Record<string, string> = {
  customer_agent: "Shopping agent",
  owner: "Owner key",
};

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
  const owner = await currentOwner(services);
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
      title: "Any AI assistant (no key)",
      auth: "No key needed",
      text: "Can chat with your store assistant. It sees no more than shoppers see on your storefront.",
      who: "Share this address with anyone.",
      url: publicUrl,
      tools: ["talk_to_store"],
    },
    {
      title: "Shopping agents (key)",
      auth: "Shopping-agent key",
      text: "Can search, compare and draft orders for a buyer. Buyers still confirm every order, and agents can read your answers to their questions.",
      who: "Give a key to a customer or partner whose assistant should shop at your store.",
      url: customerUrl,
      tools: CUSTOMER_TOOLS,
    },
    {
      title: "Your business assistant (owner key)",
      auth: "Owner key",
      text: "Can update your catalog, orders and questions. Price changes, deletions and bulk edits wait in Approvals for your approval. Agents cannot approve their own changes.",
      who: "Keep this key to yourself or your own trusted assistant. It acts for the business.",
      url: businessUrl,
      tools: BUSINESS_TOOLS,
    },
  ];

  return (
    <>
      <div className="ws-title">
        <h1>Connect agents</h1>
        <p className="ws-sub">
          AI assistants like ChatGPT or Claude can shop at {tenant.name} or help you run it. Pick
          what you need.
        </p>
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
              <summary>Technical details</summary>
              <p className="ag-hint">Address of the MCP server to add in the assistant.</p>
              <div className="ag-copy-row">
                <code>{endpoint.url}</code>
                <CopyButton text={endpoint.url} />
              </div>
              <ul className="ag-tools" aria-label={`${endpoint.title} tools`}>
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
          <h2 id="ag-keys-title">API keys</h2>
          <span className="ag-hint">
            A key is shown once. Revoking it cuts off that assistant at once.
          </span>
        </div>
        <KeyCreate customerUrl={customerUrl} businessUrl={businessUrl} />
        {keys.length === 0 ? (
          <p className="ag-empty">No keys yet.</p>
        ) : (
          <div className="ag-table-wrap">
            <table className="ag-table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Type</th>
                  <th>Created</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id} className={key.revokedAt ? "ag-revoked" : undefined}>
                    <td>
                      <code>{key.prefix}…</code>
                    </td>
                    <td>{KIND_LABELS[key.kind] ?? key.kind}</td>
                    <td>{formatWhen(key.createdAt, now)}</td>
                    <td>
                      {key.revokedAt ? (
                        <span className="ag-chip ag-chip-revoked">Revoked</span>
                      ) : (
                        <span className="ag-chip ag-chip-active">Active</span>
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
