import { beforeEach, describe, expect, it, vi } from "vitest";
import { signIn } from "@/app/signin/actions";
import { signInAccountLimiter } from "@/server/http/rate-limit";
import { uniqueSlug } from "../helpers/db";
import { expectRedirect, form, resetSession, session, testServices } from "./harness";

vi.mock("next/headers", async () => (await import("./harness")).headersMock());
vi.mock("next/navigation", async () => (await import("./harness")).navigationMock());
vi.mock("@/server/container", async () => (await import("./harness")).containerMock());

vi.mock("@/server/http/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/http/rate-limit")>()),
  signInLimiter: {
    check: async () => ({ ok: true }),
    peek: async () => ({ ok: true }),
    hit: async () => {},
  },
}));

const prev = { error: null };

async function account() {
  const email = `${uniqueSlug("o")}@example.com`;
  await testServices().tenancy.signUp({
    businessName: `Owner ${uniqueSlug("b")}`,
    email,
    password: "correct-horse",
  });
  return email;
}

beforeEach(resetSession);

describe("signIn account limit", () => {
  it("counts only failed attempts", async () => {
    const email = await account();
    for (let i = 0; i < 12; i++) {
      await expectRedirect(signIn(prev, form({ email, password: "correct-horse" })), "/app");
    }
    expect((await signInAccountLimiter.peek(`email:${email}`)).ok).toBe(true);
  });

  it("blocks after ten failures, even with the right password", async () => {
    const email = await account();
    for (let i = 0; i < 10; i++) {
      expect((await signIn(prev, form({ email, password: "wrong-wrong" }))).error).toBe(
        "The email or password is not right.",
      );
    }
    const blocked = await signIn(prev, form({ email, password: "correct-horse" }));
    expect(blocked.error).toBe("Too many attempts. Try again in a few minutes.");
    expect(session.token).toBeNull();
  });
});

describe("signIn errors", () => {
  it("asks for both fields when one is missing", async () => {
    expect((await signIn(prev, form({ email: "a@example.com", password: "" }))).error).toBe(
      "Enter your email and password.",
    );
  });
});
