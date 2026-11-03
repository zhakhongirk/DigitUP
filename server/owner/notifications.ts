import type { Notification } from "@/server/services/notifications";

export interface NotificationView {
  title: string;
  description: string;
  href: string;
}

const VIEWS: Record<string, { title: string; description: string; href: (ref: string) => string }> =
  {
    order: {
      title: "New order",
      description: "A customer confirmed an order.",
      href: (ref) => `/app/inbox?item=order:${ref}#detail`,
    },
    inquiry: {
      title: "New question",
      description: "A customer asked something the catalog can't answer.",
      href: (ref) => `/app/inbox?item=inquiry:${ref}#detail`,
    },
    change_set: {
      title: "Approval to review",
      description: "An agent proposed changes to your store.",
      href: (ref) => `/app/approvals?id=${ref}`,
    },
    "tenant.live": {
      title: "Your store is live",
      description: "Customers can now find it on the storefront.",
      href: () => "/app",
    },
  };

export function notificationView(item: Pick<Notification, "kind" | "refId">): NotificationView {
  const view = VIEWS[item.kind];
  if (!view) {
    return {
      title: "Update",
      description: "Something changed in your store.",
      href: "/app/notifications",
    };
  }
  return { title: view.title, description: view.description, href: view.href(item.refId) };
}
