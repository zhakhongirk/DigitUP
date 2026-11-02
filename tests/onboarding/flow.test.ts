import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { tenants, users } from "@/db/schema";
import { createServices } from "@/server/container";
import {
  handleOnboardingAnalyze,
  handleOnboardingStatus,
  handleOnboardingUpload,
  type OnboardingStatus,
} from "@/server/onboarding/flow";
import { recordingEvents, TEST_AUTH_SECRET, testDb } from "../helpers/db";
import { tempStorage } from "../helpers/storage";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

const storage = await tempStorage();
const services = createServices({
  db: testDb(),
  events: recordingEvents(),
  authSecret: TEST_AUTH_SECRET,
  storage,
});

const newEmail = () => `owner-${randomBytes(4).toString("hex")}@example.com`;

function uploadRequest(fields: Record<string, string | File>, cookie?: string) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  return new Request("http://localhost/api/onboarding", {
    method: "POST",
    body: form,
    headers: cookie ? { cookie } : {},
  });
}

const csvFile = (name = "menu.csv") =>
  new File(["Name,Price\nTea,4 000 ₸"], name, { type: "text/csv" });

function signUpFields(overrides: Record<string, string | File> = {}) {
  return {
    businessName: "Tea House",
    email: newEmail(),
    password: "correct-horse",
    files: csvFile(),
    ...overrides,
  };
}

const get = (cookie?: string) =>
  new Request("http://localhost/api/onboarding", { headers: cookie ? { cookie } : {} });
const post = (cookie?: string) =>
  new Request("http://localhost/api/onboarding/analyze", {
    method: "POST",
    headers: cookie ? { cookie } : {},
  });

async function signUp() {
  const response = await handleOnboardingUpload(uploadRequest(signUpFields()), services);
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  return { cookie, status: (await response.json()) as OnboardingStatus };
}

describe("handleOnboardingUpload", () => {
  it("signs the owner up with the first upload", async () => {
    const response = await handleOnboardingUpload(uploadRequest(signUpFields()), services);
    expect(response.status).toBe(201);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^session=.+HttpOnly/);

    const status = (await response.json()) as OnboardingStatus;
    expect(status.business).toMatchObject({ name: "Tea House", live: false });
    expect(status.sources).toHaveLength(1);
    expect(status.sources[0]).toMatchObject({
      filename: "menu.csv",
      kind: "csv",
      status: "uploaded",
    });
    expect(status.run?.status).toBe("pending");
    expect(status.draft).toBeNull();
  });

  it("rejects a duplicate email without leaving a tenant behind", async () => {
    const email = newEmail();
    const first = await handleOnboardingUpload(uploadRequest(signUpFields({ email })), services);
    expect(first.status).toBe(201);

    const before = await testDb().select({ id: tenants.id }).from(tenants);
    const second = await handleOnboardingUpload(
      uploadRequest(signUpFields({ email, businessName: "Another One" })),
      services,
    );
    expect(second.status).toBe(409);
    expect(second.headers.get("set-cookie")).toBeNull();
    const after = await testDb().select({ id: tenants.id }).from(tenants);
    expect(after.length).toBeGreaterThanOrEqual(before.length);
    const owners = await testDb().select().from(users).where(eq(users.email, email));
    expect(owners).toHaveLength(1);
    const [another] = await testDb().select().from(tenants).where(eq(tenants.name, "Another One"));
    expect(another).toBeUndefined();
  });

  it("rejects a short password", async () => {
    const response = await handleOnboardingUpload(
      uploadRequest(signUpFields({ password: "short" })),
      services,
    );
    expect(response.status).toBe(400);
  });

  it("requires a business name when signing up", async () => {
    const response = await handleOnboardingUpload(
      uploadRequest(signUpFields({ businessName: "  " })),
      services,
    );
    expect(response.status).toBe(400);
  });

  it("requires a description or a file", async () => {
    const response = await handleOnboardingUpload(
      uploadRequest({ businessName: "Tea", email: newEmail(), password: "correct-horse" }),
      services,
    );
    expect(response.status).toBe(400);
  });

  it("rejects unsupported files before signing up", async () => {
    const email = newEmail();
    const response = await handleOnboardingUpload(
      uploadRequest(signUpFields({ email, files: new File(["x"], "photo.png") })),
      services,
    );
    expect(response.status).toBe(400);
    expect(await testDb().select().from(users).where(eq(users.email, email))).toEqual([]);
  });

  it("rejects a body that is not a form", async () => {
    const request = new Request("http://localhost/api/onboarding", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect((await handleOnboardingUpload(request, services)).status).toBe(400);
  });

  it("adds sources for a signed-in owner", async () => {
    const { cookie } = await signUp();
    const response = await handleOnboardingUpload(
      uploadRequest({ about: "We sell tea.", files: csvFile("more.csv") }, cookie),
      services,
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toBeNull();
    const status = (await response.json()) as OnboardingStatus;
    expect(status.sources.map((s) => s.filename).sort()).toEqual([
      "Business description",
      "menu.csv",
      "more.csv",
    ]);
  });

  it("refuses uploads once the store is live", async () => {
    const { cookie } = await signUp();
    const ctx = (await services.tenancy.contextFromSession(
      decodeURIComponent(cookie.split("=")[1]!),
    ))!;
    await services.tenancy.setStatus({ ...ctx, actor: "system" }, "live");
    const response = await handleOnboardingUpload(
      uploadRequest({ about: "More" }, cookie),
      services,
    );
    expect(response.status).toBe(409);
  });
});

describe("handleOnboardingStatus", () => {
  it("requires a session", async () => {
    expect((await handleOnboardingStatus(get(), services)).status).toBe(401);
    expect((await handleOnboardingStatus(get("session=garbage"), services)).status).toBe(401);
  });

  it("returns progress for the signed-in owner", async () => {
    const { cookie } = await signUp();
    const response = await handleOnboardingStatus(get(cookie), services);
    expect(response.status).toBe(200);
    const status = (await response.json()) as OnboardingStatus;
    expect(status.business.name).toBe("Tea House");
    expect(status.sources).toHaveLength(1);
  });
});

describe("handleOnboardingAnalyze", () => {
  it("requires a session", async () => {
    expect((await handleOnboardingAnalyze(post(), services)).status).toBe(401);
  });

  it("starts a new run", async () => {
    const { cookie } = await signUp();
    const ctx = (await services.tenancy.contextFromSession(
      decodeURIComponent(cookie.split("=")[1]!),
    ))!;
    const before = await services.ingestion.getLatestRun(ctx);
    const response = await handleOnboardingAnalyze(post(cookie), services);
    expect(response.status).toBe(200);
    const after = await services.ingestion.getLatestRun(ctx);
    expect(after?.id).not.toBe(before?.id);
    expect(((await response.json()) as OnboardingStatus).run?.status).toBe("pending");
  });
});
