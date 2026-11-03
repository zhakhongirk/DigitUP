"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { notificationView } from "@/server/owner/notifications";
import { currentOwner } from "@/server/owner/session";
import { ServiceError } from "@/server/services/context";

export async function openNotification(form: FormData): Promise<void> {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/notifications");

  const id = form.get("id");
  if (typeof id !== "string" || !id) redirect("/app/notifications");

  let target = "/app/notifications";
  try {
    const item = await services.notifications.markRead(owner, id);
    target = notificationView(item).href;
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
  }
  revalidatePath("/app", "layout");
  redirect(target);
}

export async function markAllRead(): Promise<void> {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/notifications");
  await services.notifications.markAllRead(owner);
  revalidatePath("/app", "layout");
}
