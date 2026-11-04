import { beforeEach, describe, expect, it, vi } from "vitest";
import { addOffer, archiveOffer, saveOffer, setAvailability } from "@/app/app/catalog/actions";
import {
  expectRedirect,
  form,
  resetSession,
  revalidate,
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
const MISSING = "00000000-0000-4000-8000-000000000000";

const offerForm = (id: string, overrides: Record<string, string> = {}) =>
  form({
    id,
    title: "Alpha Plus",
    description: "Better",
    category: "Shoes",
    availability: "out_of_stock",
    status: "draft",
    price: "1250.50",
    currency: "kzt",
    ...overrides,
  });

async function shop() {
  const { ctx, token } = await signUpOwner();
  const ids = await seedShop(ctx);
  session.token = token;
  return { ctx, token, ids };
}

beforeEach(resetSession);

describe("saveOffer", () => {
  it("redirects to sign-in without a session", async () => {
    await expectRedirect(saveOffer(prev, offerForm("x")), "/signin?next=/app/catalog");
  });

  it("saves the edited fields", async () => {
    const { ctx, ids } = await shop();
    const result = await saveOffer(prev, offerForm(ids.Alpha!));
    expect(result).toEqual({ error: null, saved: true });
    expect(await testServices().catalog.getOffer(ctx, ids.Alpha!)).toMatchObject({
      title: "Alpha Plus",
      description: "Better",
      category: "Shoes",
      availability: "out_of_stock",
      status: "draft",
      price: 1250.5,
      currency: "KZT",
      priceStatus: "confirmed",
    });
    expect(revalidate).toHaveBeenCalledWith("/app", "layout");
  });

  it("saves price on request without a price", async () => {
    const { ctx, ids } = await shop();
    const result = await saveOffer(
      prev,
      offerForm(ids.Alpha!, { priceOnRequest: "on", price: "", currency: "" }),
    );
    expect(result.saved).toBe(true);
    expect(await testServices().catalog.getOffer(ctx, ids.Alpha!)).toMatchObject({
      price: null,
      priceStatus: "on_request",
    });
  });

  it("returns validation errors and keeps the offer unchanged", async () => {
    const { ctx, ids } = await shop();
    const cases: [Record<string, string>, string][] = [
      [{ title: " " }, "Enter a title."],
      [{ availability: "later" }, "Choose an availability."],
      [{ status: "gone" }, "Choose a status."],
      [{ price: "" }, "Enter a price or tick price on request."],
      [{ price: "abc" }, "Price must be a number such as 1250 or 1250.50."],
      [{ currency: "" }, "Enter a currency such as KZT."],
    ];
    for (const [overrides, error] of cases) {
      expect(await saveOffer(prev, offerForm(ids.Alpha!, overrides))).toEqual({
        error,
        saved: false,
      });
    }
    expect((await testServices().catalog.getOffer(ctx, ids.Alpha!))?.title).toBe("Alpha");
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("reports a missing id and a vanished offer", async () => {
    await shop();
    expect(await saveOffer(prev, form({ title: "x" }))).toEqual({
      error: "Nothing selected.",
      saved: false,
    });
    expect(await saveOffer(prev, offerForm(MISSING))).toEqual({
      error: "This offer no longer exists.",
      saved: false,
    });
  });

  it("cannot edit another tenant's offer", async () => {
    const other = await shop();
    await shop();
    const result = await saveOffer(prev, offerForm(other.ids.Alpha!));
    expect(result).toEqual({ error: "This offer no longer exists.", saved: false });
    expect((await testServices().catalog.getOffer(other.ctx, other.ids.Alpha!))?.title).toBe(
      "Alpha",
    );
  });
});

describe("non-uuid ids", () => {
  it("are reported as not found", async () => {
    await shop();
    expect(await saveOffer(prev, offerForm("abc"))).toEqual({ error: "Not found.", saved: false });
    expect(await archiveOffer(prev, form({ id: "abc" }))).toEqual({
      error: "Not found.",
      saved: false,
    });
  });
});

describe("archiveOffer", () => {
  it("redirects to sign-in without a session", async () => {
    await expectRedirect(archiveOffer(prev, form({ id: "x" })), "/signin?next=/app/catalog");
  });

  it("archives the offer", async () => {
    const { ctx, ids } = await shop();
    const result = await archiveOffer(prev, form({ id: ids.Beta! }));
    expect(result).toEqual({ error: null, saved: true });
    const { catalog } = testServices();
    expect((await catalog.getOffer(ctx, ids.Beta!))?.status).toBe("archived");
    expect((await catalog.getOffer(ctx, ids.Alpha!))?.status).toBe("active");
    expect(revalidate).toHaveBeenCalledWith("/app", "layout");
  });

  it("reports a missing id and an unknown offer", async () => {
    await shop();
    expect(await archiveOffer(prev, form({}))).toEqual({
      error: "Nothing selected.",
      saved: false,
    });
    const result = await archiveOffer(prev, form({ id: MISSING }));
    expect(result.saved).toBe(false);
    expect(result.error).toEqual(expect.any(String));
  });

  it("cannot archive another tenant's offer", async () => {
    const other = await shop();
    await shop();
    const result = await archiveOffer(prev, form({ id: other.ids.Alpha! }));
    expect(result.saved).toBe(false);
    expect((await testServices().catalog.getOffer(other.ctx, other.ids.Alpha!))?.status).toBe(
      "active",
    );
  });
});

describe("addOffer", () => {
  it("redirects to sign-in without a session", async () => {
    await expectRedirect(addOffer(), "/signin?next=/app/catalog");
  });

  it("creates a draft offer and opens its edit panel", async () => {
    const { ctx } = await shop();
    const before = await testServices().catalog.searchOffers(ctx, { statuses: ["draft"] });
    expect(before.total).toBe(0);

    const redirected = await addOffer().catch((error: Error) => error.message);
    const drafts = await testServices().catalog.searchOffers(ctx, { statuses: ["draft"] });
    expect(drafts.items).toHaveLength(1);
    expect(drafts.items[0]).toMatchObject({
      title: "New offer",
      price: null,
      availability: "unknown",
      offerTypeKey: "item",
    });
    expect(redirected).toBe(`REDIRECT:/app/catalog?status=draft&offer=${drafts.items[0]!.id}`);
  });
});

describe("addOffer in an empty store", () => {
  it("creates the default offer type and opens a draft", async () => {
    const { ctx, token } = await signUpOwner();
    session.token = token;
    expect(await testServices().catalog.listOfferTypes(ctx)).toHaveLength(0);

    const redirected = await addOffer().catch((error: Error) => error.message);
    const types = await testServices().catalog.listOfferTypes(ctx);
    expect(types.map((type) => type.key)).toEqual(["item"]);
    const drafts = await testServices().catalog.searchOffers(ctx, { statuses: ["draft"] });
    expect(drafts.items).toHaveLength(1);
    expect(redirected).toBe(`REDIRECT:/app/catalog?status=draft&offer=${drafts.items[0]!.id}`);

    await addOffer().catch(() => undefined);
    expect(await testServices().catalog.listOfferTypes(ctx)).toHaveLength(1);
  });
});

describe("setAvailability", () => {
  it("reports an unknown offer", async () => {
    await shop();
    const result = await setAvailability(prev, form({ id: MISSING, availability: "out_of_stock" }));
    expect(result.saved).toBe(false);
    expect(result.error).toEqual(expect.any(String));
  });

  it("flips availability", async () => {
    const { ctx, ids } = await shop();
    const result = await setAvailability(
      prev,
      form({ id: ids.Alpha!, availability: "out_of_stock" }),
    );
    expect(result).toEqual({ error: null, saved: true });
    expect((await testServices().catalog.getOffer(ctx, ids.Alpha!))?.availability).toBe(
      "out_of_stock",
    );
  });
});
