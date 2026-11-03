import type { Services } from "@/server/container";
import type { TenantContext } from "@/server/services/context";
import type { AuditEvent } from "@/server/services/audit";
import { parseOps, summarize } from "./changes";
import { orderNumber } from "./inbox";

export const ACTOR_LABELS: Record<AuditEvent["actor"], string> = {
  owner: "You",
  business_agent: "Business Agent",
  customer_agent: "Customer Agent",
  system: "System",
};

const ACTION_LABELS: Record<string, string> = {
  "api_key.created": "Created an API key",
  "api_key.revoked": "Revoked an API key",
  "business_model.applied": "Published the business model",
  "business_model.confirmed": "Confirmed the business model",
  "business_model.proposed": "Proposed a business model",
  "change_set.applied": "Approved changes",
  "change_set.created": "Requested an approval",
  "change_set.rejected": "Rejected changes",
  "conversation.created": "Started a conversation",
  "conversation.status_changed": "Changed a conversation status",
  "inquiry.answered": "Answered a question",
  "inquiry.created": "Sent a question to the owner",
  "inquiry.status_changed": "Changed a question status",
  "offer.archived": "Archived an offer",
  "offer.created": "Added an offer",
  "offer.price_updated": "Changed a price",
  "offer.updated": "Edited an offer",
  "order.created": "Drafted an order",
  "order.status_changed": "Changed an order status",
  "order.contact_updated": "Updated order contact",
  "order.submitted": "Order confirmed by the buyer",
  "policies.updated": "Updated store policies",
  "profile.updated": "Updated store profile",
  "user.password_changed": "Changed the password",
  "user.sessions_revoked": "Signed out everywhere",
  "proposal_run.started": "Started analysing the uploaded files",
  "source_asset.uploaded": "Uploaded a file",
  "tenant.created": "Created the store",
  "tenant.provisioned": "Launched the store",
  "tenant.status_changed": "Changed the store status",
  "user.created": "Created the owner account",
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function statusOf(value: unknown): string | null {
  if (value && typeof value === "object" && "status" in value) {
    const status = (value as { status: unknown }).status;
    return typeof status === "string" ? status : null;
  }
  return null;
}

/** Short "before → after" note for status changes, empty otherwise. */
export function auditChange(event: Pick<AuditEvent, "before" | "after">): string {
  const before = statusOf(event.before);
  const after = statusOf(event.after);
  if (before && after && before !== after) {
    return `${before.replace(/_/g, " ")} → ${after.replace(/_/g, " ")}`;
  }
  return "";
}

export interface AuditTarget {
  name: string;
  href: string | null;
}

type AuditRef = Pick<AuditEvent, "id" | "entity" | "entityId" | "before" | "after">;

function field(value: unknown, key: string): string | null {
  if (value && typeof value === "object" && key in value) {
    const found = (value as Record<string, unknown>)[key];
    return typeof found === "string" && found ? found : null;
  }
  return null;
}

function eventTitle(event: AuditRef): string | null {
  return field(event.after, "title") ?? field(event.before, "title");
}

/** Names the item each event touched, with one batched lookup per entity type. */
export async function resolveAuditTargets(
  services: Services,
  ctx: TenantContext,
  events: AuditRef[],
): Promise<Map<string, AuditTarget>> {
  const targets = new Map<string, AuditTarget>();
  const offerIds = new Set<string>();
  let hasChangeSets = false;
  for (const event of events) {
    if (event.entity === "offer" && event.entityId) offerIds.add(event.entityId);
    if (event.entity === "change_set" && event.entityId) hasChangeSets = true;
  }

  const [offers, changeSets] = await Promise.all([
    offerIds.size > 0 ? services.catalog.getOffers(ctx, [...offerIds]) : [],
    hasChangeSets ? services.approvals.listChangeSets(ctx, { limit: 200 }) : [],
  ]);
  const offerById = new Map(offers.map((offer) => [offer.id, offer]));
  const changeSetById = new Map(changeSets.map((changeSet) => [changeSet.id, changeSet]));

  for (const event of events) {
    const id = event.entityId;
    if (!id) continue;
    if (event.entity === "order") {
      targets.set(event.id, {
        name: `Order ${orderNumber(id)}`,
        href: `/app/inbox?item=${encodeURIComponent(`order:${id}`)}`,
      });
    } else if (event.entity === "inquiry") {
      const subject = field(event.after, "subject");
      targets.set(event.id, {
        name: subject ? `Question: ${subject}` : "Question",
        href: `/app/inbox?item=${encodeURIComponent(`inquiry:${id}`)}`,
      });
    } else if (event.entity === "offer") {
      const offer = offerById.get(id);
      const name = offer?.title ?? eventTitle(event);
      if (name) {
        targets.set(event.id, {
          name,
          href: offer ? `/app/catalog?status=all&offer=${id}` : null,
        });
      }
    } else if (event.entity === "change_set") {
      const changeSet = changeSetById.get(id);
      const ops = changeSet ? parseOps(changeSet.ops) : null;
      targets.set(event.id, {
        name: ops ? summarize(ops) : "Approval",
        href: changeSet ? `/app/approvals?id=${id}` : null,
      });
    }
  }
  return targets;
}
