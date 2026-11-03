import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { proposalRuns, tenants, users } from "@/db/schema";
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

describe("upload size cap", () => {
  it("rejects files that together exceed 60 MB", async () => {
    const email = newEmail();
    const form = new FormData();
    form.append("businessName", "Tea House");
    form.append("email", email);
    form.append("password", "correct-horse");
    for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
      form.append("files", new File([new Uint8Array(16 * 1024 * 1024)], name));
    }
    const encoded = new Response(form);
    const contentType = encoded.headers.get("content-type") ?? "";
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) return controller.close();
        controller.enqueue(bytes.subarray(offset, offset + 1024 * 1024));
        offset += 1024 * 1024;
      },
    });
    const response = await handleOnboardingUpload(
      new Request("http://localhost/api/onboarding", {
        method: "POST",
        body,
        headers: { "content-type": contentType },
        duplex: "half",
      } as RequestInit),
      services,
    );
    expect(response.status).toBe(413);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await testDb().select().from(users).where(eq(users.email, email))).toEqual([]);
  });
});

describe("chunked upload cap", () => {
  it("rejects an oversize body without a content-length", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (cancelled) return;
        if (sent++ >= 70) controller.close();
        else controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("http://localhost/api/onboarding", {
      method: "POST",
      body,
      headers: { "content-type": "multipart/form-data; boundary=x" },
      duplex: "half",
    } as RequestInit);
    const response = await handleOnboardingUpload(request, services);
    expect(response.status).toBe(413);
    expect(sent).toBeLessThan(70);
  });

  it("still accepts a normal upload", async () => {
    const response = await handleOnboardingUpload(uploadRequest(signUpFields()), services);
    expect(response.status).toBe(201);
  });
});

describe("analyze rate limit", () => {
  it("allows five runs per tenant in ten minutes", async () => {
    const { cookie } = await signUp();
    for (let i = 0; i < 5; i++) {
      expect((await handleOnboardingAnalyze(post(cookie), services)).status).toBe(200);
    }
    const limited = await handleOnboardingAnalyze(post(cookie), services);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).not.toBeNull();
  });
});

describe("stalled analysis", () => {
  async function backdate(cookie: string, ms: number) {
    const ctx = (await services.tenancy.contextFromSession(cookie.replace("session=", "")))!;
    const run = (await services.ingestion.getLatestRun(ctx))!;
    await testDb()
      .update(proposalRuns)
      .set({ updatedAt: new Date(Date.now() - ms) })
      .where(eq(proposalRuns.id, run.id));
    return ctx;
  }

  it("flags a run with no progress as slow", async () => {
    const { cookie } = await signUp();
    await backdate(cookie, 2 * 60_000);
    const status = (await (
      await handleOnboardingStatus(get(cookie), services)
    ).json()) as OnboardingStatus;
    expect(status.run).toMatchObject({ status: "pending", slow: true });
  });

  it("fails a timed out run, then retry starts a new one", async () => {
    const { cookie } = await signUp();
    await backdate(cookie, 10 * 60_000);
    const failed = (await (
      await handleOnboardingStatus(get(cookie), services)
    ).json()) as OnboardingStatus;
    expect(failed.run).toMatchObject({ status: "failed", slow: false });
    expect(failed.run?.error).toMatch(/did not finish in time/);

    const retried = (await (
      await handleOnboardingAnalyze(post(cookie), services)
    ).json()) as OnboardingStatus;
    expect(retried.run).toMatchObject({ status: "pending", error: null, slow: false });
  });

  it("does not flag a fresh run", async () => {
    const { status } = await signUp();
    expect(status.run?.slow).toBe(false);
  });
});
