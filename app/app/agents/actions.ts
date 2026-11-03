"use server";

import { revalidatePath } from "next/cache";
import { getServices } from "@/server/container";
import { ownerT } from "@/server/owner/lang";
import { currentOwner } from "@/server/owner/session";
import { ServiceError } from "@/server/services/context";

export interface CreateKeyState {
  key: string | null;
  kind: "customer_agent" | "owner" | null;
  error: string | null;
}

export interface RevokeState {
  error: string | null;
}

export async function createKey(_prev: CreateKeyState, form: FormData): Promise<CreateKeyState> {
  const services = await getServices();
  const { t, msg } = await ownerT();
  const owner = await currentOwner(services);
  if (!owner) return { key: null, kind: null, error: t("err.sessionExpired") };

  const kind = form.get("kind");
  if (kind !== "customer_agent" && kind !== "owner") {
    return { key: null, kind: null, error: t("ag.chooseType") };
  }
  try {
    const created = await services.tenancy.createApiKey(owner, kind);
    revalidatePath("/app/agents");
    return { key: created.key, kind, error: null };
  } catch (error) {
    if (error instanceof ServiceError) return { key: null, kind: null, error: msg(error.message) };
    throw error;
  }
}

export async function revokeKey(_prev: RevokeState, form: FormData): Promise<RevokeState> {
  const services = await getServices();
  const { t, msg } = await ownerT();
  const owner = await currentOwner(services);
  if (!owner) return { error: t("err.sessionExpired") };

  const id = form.get("id");
  if (typeof id !== "string" || !id) return { error: t("err.nothingSelected") };
  try {
    await services.tenancy.revokeApiKey(owner, id);
  } catch (error) {
    if (error instanceof ServiceError) return { error: msg(error.message) };
    throw error;
  }
  revalidatePath("/app/agents");
  return { error: null };
}
