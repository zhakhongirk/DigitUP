import { beforeEach, describe, expect, it, vi } from "vitest";
import { createKey } from "@/app/app/agents/actions";
import { saveProfile } from "@/app/app/settings/actions";
import { inviteStaff, removeStaff } from "@/app/app/settings/staff-actions";
import { requestPasswordReset } from "@/app/signin/forgot/actions";
import { resetPassword } from "@/app/signin/reset/actions";
import { passwordResetAccountLimiter, passwordResetLimiter } from "@/server/http/rate-limit";
import { uniqueSlug } from "../helpers/db";
import { expectRedirect, form, resetSession, session, signUpOwner, testServices } from "./harness";

const sent = vi.hoisted(() => [] as Array<{ to: string; link: string; subject: string }>);

vi.mock("next/headers", async () => (await import("./harness")).headersMock());
vi.mock("next/cache", async () => (await import("./harness")).cacheMock());
vi.mock("next/navigation", async () => (await import("./harness")).navigationMock());
vi.mock("@/server/container", async () => (await import("./harness")).containerMock());
vi.mock("@/server/mail", () => ({
  sendMailInBackground: (mail: { to: string; link: string; subject: string }) => {
    sent.push(mail);
  },
}));

const forgotPrev = { error: null, sent: false };
const settingsPrev = { error: null, saved: false };

beforeEach(() => {
  resetSession();
  sent.length = 0;
});

function tokenFrom(link: string): string {
  return new URL(link).searchParams.get("token")!;
}

describe("requestPasswordReset", () => {
  it("gives the same answer for known and unknown addresses", async () => {
    const known = `${uniqueSlug("k")}@example.com`;
    await testServices().tenancy.signUp({
      businessName: `Shop ${uniqueSlug("b")}`,
      email: known,
      password: "correct-horse",
    });
    const unknown = `${uniqueSlug("u")}@example.com`;

    const a = await requestPasswordReset(forgotPrev, form({ email: known }));
    const b = await requestPasswordReset(forgotPrev, form({ email: unknown }));

    expect(a).toEqual({ error: null, sent: true });
    expect(b).toEqual(a);
    expect(sent.map((mail) => mail.to)).toEqual([known]);
  });

  it("does not change its reply when the per-address limit is reached", async () => {
    const email = `${uniqueSlug("l")}@example.com`;
    for (let i = 0; i < 3; i++) passwordResetAccountLimiter.hit(`email:${email}`);
    expect(await requestPasswordReset(forgotPrev, form({ email }))).toEqual({
      error: null,
      sent: true,
    });
    expect(sent).toHaveLength(0);
  });

  it("requires an address and honours the per-IP limit", async () => {
    expect((await requestPasswordReset(forgotPrev, form({ email: "  " }))).error).toBe(
      "Enter your email.",
    );
    const check = vi.spyOn(passwordResetLimiter, "check").mockReturnValue({
      ok: false,
      retryAfterSeconds: 60,
    });
    const limited = await requestPasswordReset(forgotPrev, form({ email: "a@example.com" }));
    check.mockRestore();
    expect(limited.sent).toBe(false);
    expect(limited.error).toMatch(/Too many/);
  });
});

describe("resetPassword action", () => {
  it("resets through the emailed link and sends the user to sign-in", async () => {
    const email = `${uniqueSlug("r")}@example.com`;
    await testServices().tenancy.signUp({
      businessName: `Shop ${uniqueSlug("b")}`,
      email,
      password: "correct-horse",
    });
    await requestPasswordReset(forgotPrev, form({ email }));
    const token = tokenFrom(sent[0]!.link);

    expect(
      await resetPassword({ error: null }, form({ token, password: "abcdefgh1", confirm: "x" })),
    ).toEqual({ error: "The passwords do not match." });
    await expectRedirect(
      resetPassword({ error: null }, form({ token, password: "abcdefgh1", confirm: "abcdefgh1" })),
      "/signin?reset=1",
    );
    expect(await testServices().tenancy.signIn({ email, password: "abcdefgh1" })).not.toBeNull();

    const again = await resetPassword(
      { error: null },
      form({ token, password: "abcdefgh2", confirm: "abcdefgh2" }),
    );
    expect(again.error).toBe("This link is invalid or has expired");
  });
});

describe("staff role in the owner area", () => {
  async function staffSession() {
    const { ctx, token } = await signUpOwner();
    session.token = token;
    const email = `${uniqueSlug("s")}@example.com`;
    expect(await inviteStaff(settingsPrev, form({ email }))).toMatchObject({ saved: true });
    const invite = tokenFrom(sent[0]!.link);
    await testServices().tenancy.resetPassword(invite, "staff-password");
    const staffToken = (await testServices().tenancy.signIn({
      email,
      password: "staff-password",
    }))!;
    return { ctx, ownerToken: token, staffToken, email };
  }

  it("lets the owner invite, list and remove staff", async () => {
    const { ctx, email } = await staffSession();
    expect(sent[0]).toMatchObject({ to: email });
    const [member] = await testServices().tenancy.listStaff(ctx);
    expect(member!.email).toBe(email);
    expect(await removeStaff(settingsPrev, form({ id: member!.id }))).toMatchObject({
      saved: true,
    });
    expect(await testServices().tenancy.listStaff(ctx)).toEqual([]);
  });

  it("sends staff away from owner-only actions", async () => {
    const { staffToken } = await staffSession();
    session.token = staffToken;
    await expectRedirect(saveProfile(settingsPrev, form({ name: "Hacked" })), "/app/inbox");
    await expectRedirect(inviteStaff(settingsPrev, form({ email: "a@example.com" })), "/app/inbox");
    await expectRedirect(
      removeStaff(settingsPrev, form({ id: "00000000-0000-4000-8000-000000000000" })),
      "/app/inbox",
    );
    await expectRedirect(
      createKey({ key: null, kind: null, error: null }, form({ kind: "owner" })),
      "/app/inbox",
    );
  });
});
