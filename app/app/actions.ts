"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getServices } from "@/server/container";
import { clearSessionCookie, currentOwner } from "@/server/owner/session";
import { ServiceError } from "@/server/services/context";
import type { InquiryStatus, OrderStatus } from "@/server/services/orders";

export interface ActionState {
  error: string | null;
}

const ORDER_STATUSES: OrderStatus[] = ["received", "processing", "completed", "cancelled"];
const INQUIRY_STATUSES: InquiryStatus[] = ["new", "in_progress", "completed"];

const NOT_FOUND = "Not found.";

function isUuid(value: string): boolean {
  return z.uuid().safeParse(value).success;
}

function pick<T extends string>(values: readonly T[], value: FormDataEntryValue | null): T | null {
  return values.find((v) => v === value) ?? null;
}

export async function updateStatus(_prev: ActionState, form: FormData): Promise<ActionState> {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/inbox");

  const kind = form.get("kind");
  const id = form.get("id");
  if (typeof id !== "string" || !id) return { error: "Nothing selected." };
  if (!isUuid(id)) return { error: NOT_FOUND };

  try {
    if (kind === "order") {
      const status = pick(ORDER_STATUSES, form.get("status"));
      if (!status) return { error: "Unknown order status." };
      await services.orders.updateOrderStatus(owner, id, status);
    } else if (kind === "inquiry") {
      const status = pick(INQUIRY_STATUSES, form.get("status"));
      if (!status) return { error: "Unknown status." };
      await services.orders.updateInquiryStatus(owner, id, status);
    } else {
      return { error: "Nothing selected." };
    }
  } catch (error) {
    if (error instanceof ServiceError) return { error: error.message };
    throw error;
  }
  revalidatePath("/app", "layout");
  return { error: null };
}

export async function answerInquiry(_prev: ActionState, form: FormData): Promise<ActionState> {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/inbox");

  const id = form.get("id");
  const answer = form.get("answer");
  if (typeof id !== "string" || !id) return { error: "Nothing selected." };
  if (!isUuid(id)) return { error: NOT_FOUND };
  if (typeof answer !== "string" || !answer.trim()) return { error: "Write an answer first." };

  try {
    await services.orders.answerInquiry(owner, id, answer);
  } catch (error) {
    if (error instanceof ServiceError) return { error: error.message };
    throw error;
  }
  revalidatePath("/app", "layout");
  return { error: null };
}

export async function decideChangeSet(_prev: ActionState, form: FormData): Promise<ActionState> {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/approvals");

  const id = form.get("id");
  const decision = form.get("decision");
  if (typeof id !== "string" || !id) return { error: "Nothing selected." };
  if (!isUuid(id)) return { error: NOT_FOUND };
  try {
    if (decision === "approve") await services.approvals.approveChangeSet(owner, id);
    else if (decision === "reject") await services.approvals.rejectChangeSet(owner, id);
    else return { error: "Choose approve or reject." };
  } catch (error) {
    if (error instanceof ServiceError) return { error: error.message };
    throw error;
  }
  revalidatePath("/app", "layout");
  return { error: null };
}

export async function signOut(): Promise<void> {
  await clearSessionCookie();
  redirect("/signin");
}
