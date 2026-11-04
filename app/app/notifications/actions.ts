"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { notificationView } from "@/server/owner/notifications";
import { ownerLang } from "@/server/owner/lang";
import { ownerOnly } from "@/server/owner/access";
import { currentOwner } from "@/server/owner/session";
import { ServiceError } from "@/server/services/context";

export async function openNotification(form: FormData): Promise<void> {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/notifications");
  ownerOnly(owner);

  const id = form.get("id");
  if (typeof id !== "string" || !id) redirect("/app/notifications");

  let target = "/app/notifications";
  try {
    const item = await services.notifications.markRead(owner, id);
    target = notificationView(item, await ownerLang()).href;
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    target = "/app/notifications?err=open";
  }
  revalidatePath("/app", "layout");
  redirect(target);
}

export async function markAllRead(): Promise<void> {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/notifications");
  ownerOnly(owner);
  await services.notifications.markAllRead(owner);
  revalidatePath("/app", "layout");
}
