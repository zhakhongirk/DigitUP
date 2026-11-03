import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  changePassword,
  savePolicies,
  saveProfile,
  signOutEverywhere,
} from "@/app/app/settings/actions";
import { passwordChangeLimiter } from "@/server/http/rate-limit";
import {
  expectRedirect,
  form,
  resetSession,
  revalidate,
  session,
  signUpOwner,
  testServices,
} from "./harness";
import { uniqueSlug } from "../helpers/db";

vi.mock("next/headers", async () => (await import("./harness")).headersMock());
vi.mock("next/cache", async () => (await import("./harness")).cacheMock());
vi.mock("next/navigation", async () => (await import("./harness")).navigationMock());
vi.mock("@/server/container", async () => (await import("./harness")).containerMock());

const prev = { error: null, saved: false };

async function signedIn() {
  const { ctx, token } = await signUpOwner();
  session.token = token;
  return ctx;
}

beforeEach(resetSession);

describe("saveProfile", () => {
  it("redirects to sign-in without a session", async () => {
    await expectRedirect(saveProfile(prev, form({ name: "X" })), "/signin?next=/app/settings");
  });

  it("requires a business name", async () => {
    const ctx = await signedIn();
    const before = (await testServices().catalog.getBusinessModel(ctx)).profile.name;
    expect(await saveProfile(prev, form({ name: "   " }))).toEqual({
      error: "Enter a business name.",
      saved: false,
    });
    expect((await testServices().catalog.getBusinessModel(ctx)).profile.name).toBe(before);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("saves the profile", async () => {
    const ctx = await signedIn();
    const result = await saveProfile(
      prev,
      form({ name: " Bright Shop ", description: "Shoes and more", category: "Retail" }),
    );
    expect(result).toMatchObject({ error: null, saved: true });
    const { profile } = await testServices().catalog.getBusinessModel(ctx);
    expect(profile).toMatchObject({
      name: "Bright Shop",
      description: "Shoes and more",
      category: "Retail",
    });
    expect(revalidate).toHaveBeenCalledWith("/app", "layout");
  });
});

describe("savePolicies", () => {
  it("redirects to sign-in without a session", async () => {
    await expectRedirect(savePolicies(prev, form({})), "/signin?next=/app/settings");
  });

  it("saves filled policies and clears blank ones", async () => {
    const ctx = await signedIn();
    const first = await savePolicies(
      prev,
      form({ "policy.delivery": " Within 3 days ", "policy.returns": "14 days" }),
    );
    expect(first).toMatchObject({ error: null, saved: true });
    let policies = (await testServices().catalog.getBusinessModel(ctx)).policies;
    expect(policies).toMatchObject({
      delivery: "Within 3 days",
      returns: "14 days",
      payment: null,
    });

    await savePolicies(prev, form({ "policy.delivery": "", "policy.returns": "30 days" }));
    policies = (await testServices().catalog.getBusinessModel(ctx)).policies;
    expect(policies).toMatchObject({ delivery: null, returns: "30 days" });
    expect(revalidate).toHaveBeenCalledWith("/app", "layout");
  });
});

describe("changePassword", () => {
  const pw = (fields: Record<string, string>) => form(fields);

  it("redirects to sign-in without a session", async () => {
    await expectRedirect(
      changePassword(prev, pw({ current: "a", next: "b", confirm: "b" })),
      "/signin?next=/app/settings",
    );
  });

  it("reports mismatched, wrong and weak passwords", async () => {
    await signedIn();
    expect(
      await changePassword(
        prev,
        pw({ current: "correct-horse", next: "brand-new-pass", confirm: "other" }),
      ),
    ).toEqual({ error: "The new passwords do not match.", saved: false });
    expect(
      await changePassword(
        prev,
        pw({ current: "wrong-wrong", next: "brand-new-pass", confirm: "brand-new-pass" }),
      ),
    ).toEqual({ error: "Current password is wrong", saved: false });
    expect(
      (
        await changePassword(
          prev,
          pw({ current: "correct-horse", next: "short", confirm: "short" }),
        )
      ).error,
    ).toBe("Password must be at least 8 characters");
  });

  it("changes the password and keeps the owner signed in", async () => {
    const ctx = await signedIn();
    const old = session.token!;
    const result = await changePassword(
      prev,
      pw({ current: "correct-horse", next: "brand-new-pass", confirm: "brand-new-pass" }),
    );
    expect(result).toMatchObject({ error: null, saved: true });
    expect(session.token).not.toBe(old);
    const tenancy = testServices().tenancy;
    expect(await tenancy.contextFromSession(old)).toBeNull();
    expect(await tenancy.contextFromSession(session.token!)).toMatchObject({ userId: ctx.userId });
  });

  it("rate limits attempts per user", async () => {
    const ctx = await signedIn();
    const attempt = () =>
      changePassword(
        prev,
        pw({ current: "wrong-wrong", next: "brand-new-pass", confirm: "brand-new-pass" }),
      );
    for (let i = 0; i < 5; i++) expect((await attempt()).error).toBe("Current password is wrong");
    expect((await attempt()).error).toBe("Too many attempts. Try again in a few minutes.");
    expect(passwordChangeLimiter.check(`user:${ctx.userId}`).ok).toBe(false);
  });
});

describe("signOutEverywhere", () => {
  it("redirects to sign-in without a session", async () => {
    await expectRedirect(signOutEverywhere(), "/signin?next=/app/settings");
  });

  it("revokes every session and clears the cookie", async () => {
    const { tenancy } = testServices();
    const email = `${uniqueSlug("o")}@example.com`;
    const { token: first } = await tenancy.signUp({
      businessName: `Owner ${uniqueSlug("b")}`,
      email,
      password: "correct-horse",
    });
    const second = await tenancy.signIn({ email, password: "correct-horse" });
    session.token = first;
    await expectRedirect(signOutEverywhere(), "/signin");
    expect(session.cleared).toBe(true);
    expect(await tenancy.contextFromSession(first)).toBeNull();
    expect(await tenancy.contextFromSession(second!)).toBeNull();
  });
});
