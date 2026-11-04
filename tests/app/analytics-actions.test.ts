import { beforeEach, describe, expect, it, vi } from "vitest";
import { linkTerm, unlinkTerm } from "@/app/app/analytics/actions";
import {
  expectRedirect,
  form,
  resetSession,
  seedShop,
  session,
  signUpOwner,
  testServices,
} from "./harness";

vi.mock("next/headers", async () => (await import("./harness")).headersMock());
vi.mock("next/cache", async () => (await import("./harness")).cacheMock());
vi.mock("next/navigation", async () => (await import("./harness")).navigationMock());
vi.mock("@/server/container", async () => (await import("./harness")).containerMock());

const prev = { error: null, saved: false };

function picks(term: string, values: string[]): FormData {
  const data = form({ term });
  for (const value of values) data.append("pick", value);
  return data;
}

beforeEach(resetSession);

describe("linkTerm", () => {
  it("redirects to sign-in without a session", async () => {
    await expectRedirect(linkTerm(prev, picks("x", [])), "/signin?next=/app/analytics");
  });

  it("asks for a phrase and at least one product", async () => {
    const { token } = await signUpOwner();
    session.token = token;
    expect((await linkTerm(prev, picks("  ", ["offer:x"]))).error).toBeTruthy();
    expect((await linkTerm(prev, picks("blue thing", []))).error).toBeTruthy();
  });

  it("links the picked offers, then unlinks the phrase", async () => {
    const { ctx, token } = await signUpOwner();
    const ids = await seedShop(ctx);
    session.token = token;
    const result = await linkTerm(prev, picks("Cheap Thing", [`offer:${ids.Alpha}`]));
    expect(result).toEqual({ error: null, saved: true });
    const links = await testServices().intent.listLinks(ctx);
    expect(links).toMatchObject([
      { term: "cheap thing", offerIds: [ids.Alpha], titles: ["Alpha"] },
    ]);

    const removed = await unlinkTerm(prev, form({ term: "cheap thing" }));
    expect(removed).toEqual({ error: null, saved: true });
    expect(await testServices().intent.listLinks(ctx)).toEqual([]);
    expect((await unlinkTerm(prev, form({ term: "cheap thing" }))).error).toBeTruthy();
  });

  it("reports a service error instead of throwing", async () => {
    const { token } = await signUpOwner();
    session.token = token;
    const result = await linkTerm(prev, picks("ghost", ["model:Nothing"]));
    expect(result.saved).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
