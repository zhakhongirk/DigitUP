"use server";

import { getServices } from "@/server/container";
import { ownerT } from "@/server/owner/lang";
import { ownerOnly } from "@/server/owner/access";
import { currentOwner } from "@/server/owner/session";

export interface KeyState {
  key: string | null;
  error: string | null;
}

export async function createCustomerKey(): Promise<KeyState> {
  const services = await getServices();
  const { t } = await ownerT();
  const owner = await currentOwner(services);
  if (!owner) return { key: null, error: t("err.sessionExpired") };
  ownerOnly(owner);
  const created = await services.tenancy.createApiKey(owner, "customer_agent");
  return { key: created.key, error: null };
}
