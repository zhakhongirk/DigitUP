"use server";

import { revalidatePath } from "next/cache";
import { getServices } from "@/server/container";
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

const EXPIRED = "Your session has expired. Sign in again.";

export async function createKey(_prev: CreateKeyState, form: FormData): Promise<CreateKeyState> {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) return { key: null, kind: null, error: EXPIRED };

  const kind = form.get("kind");
  if (kind !== "customer_agent" && kind !== "owner") {
    return { key: null, kind: null, error: "Choose a key type." };
  }
  try {
    const created = await services.tenancy.createApiKey(owner, kind);
    revalidatePath("/app/agents");
    return { key: created.key, kind, error: null };
  } catch (error) {
    if (error instanceof ServiceError) return { key: null, kind: null, error: error.message };
    throw error;
  }
}

export async function revokeKey(_prev: RevokeState, form: FormData): Promise<RevokeState> {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) return { error: EXPIRED };

  const id = form.get("id");
  if (typeof id !== "string" || !id) return { error: "Nothing selected." };
  try {
    await services.tenancy.revokeApiKey(owner, id);
  } catch (error) {
    if (error instanceof ServiceError) return { error: error.message };
    throw error;
  }
  revalidatePath("/app/agents");
  return { error: null };
}
