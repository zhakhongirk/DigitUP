import { describe, expect, it } from "vitest";
import { NOTIFICATION_KINDS } from "@/server/events/handlers";
import { notificationView } from "@/server/owner/notifications";

const ref = "11111111-1111-4111-8111-111111111111";

describe("notificationView", () => {
  it("links orders and inquiries to the inbox item", () => {
    expect(notificationView({ kind: "order", refId: ref })).toMatchObject({
      title: "New order",
      href: `/app/inbox?item=order:${ref}#detail`,
    });
    expect(notificationView({ kind: "inquiry", refId: ref })).toMatchObject({
      title: "New question",
      href: `/app/inbox?item=inquiry:${ref}#detail`,
    });
  });

  it("links change sets and the live store", () => {
    expect(notificationView({ kind: "change_set", refId: ref }).href).toBe(
      `/app/changes?id=${ref}`,
    );
    expect(notificationView({ kind: "tenant.live", refId: ref }).href).toBe("/app");
  });

  it("renders every kind the handlers write", () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(notificationView({ kind, refId: ref }).title).not.toBe("Update");
    }
  });

  it("falls back for unknown kinds", () => {
    expect(notificationView({ kind: "mystery", refId: ref })).toEqual({
      title: "Update",
      description: "Something changed in your store.",
      href: "/app/notifications",
    });
  });
});
