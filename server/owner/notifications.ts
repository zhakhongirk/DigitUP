import type { Notification } from "@/server/services/notifications";
import type { Lang } from "@/server/storefront/i18n";
import { tr, type TextKey } from "@/shared/owner-copy";

export interface NotificationView {
  title: string;
  description: string;
  href: string;
}

const VIEWS: Record<
  string,
  { title: TextKey; description: TextKey; href: (ref: string) => string }
> = {
  order: {
    title: "nt.order.title",
    description: "nt.order.body",
    href: (ref) => `/app/inbox?item=order:${ref}#detail`,
  },
  inquiry: {
    title: "nt.inquiry.title",
    description: "nt.inquiry.body",
    href: (ref) => `/app/inbox?item=inquiry:${ref}#detail`,
  },
  change_set: {
    title: "nt.change_set.title",
    description: "nt.change_set.body",
    href: (ref) => `/app/approvals?id=${ref}`,
  },
  "tenant.live": {
    title: "nt.live.title",
    description: "nt.live.body",
    href: () => "/app",
  },
};

export function notificationView(
  item: Pick<Notification, "kind" | "refId">,
  lang: Lang = "en",
): NotificationView {
  const view = VIEWS[item.kind];
  if (!view) {
    return {
      title: tr(lang, "nt.other.title"),
      description: tr(lang, "nt.other.body"),
      href: "/app/notifications",
    };
  }
  return {
    title: tr(lang, view.title),
    description: tr(lang, view.description),
    href: view.href(item.refId),
  };
}
