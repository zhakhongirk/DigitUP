import { beforeEach, describe, it, vi } from "vitest";
import { openNotification } from "@/app/app/notifications/actions";
import { expectRedirect, form, resetSession, session, signUpOwner } from "./harness";

vi.mock("next/headers", async () => (await import("./harness")).headersMock());
vi.mock("next/cache", async () => (await import("./harness")).cacheMock());
vi.mock("next/navigation", async () => (await import("./harness")).navigationMock());
vi.mock("@/server/container", async () => (await import("./harness")).containerMock());

const MISSING = "00000000-0000-4000-8000-000000000000";

beforeEach(resetSession);

describe("openNotification", () => {
  it("sends the owner back to the list with an error flag when the notification is gone", async () => {
    const { token } = await signUpOwner();
    session.token = token;
    await expectRedirect(openNotification(form({ id: MISSING })), "/app/notifications?err=open");
  });
});
