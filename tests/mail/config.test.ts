import { afterEach, describe, expect, it, vi } from "vitest";
import { isMailConfigured, smtpConfigFromEnv } from "@/server/mail";

afterEach(() => vi.unstubAllEnvs());

describe("mail configuration", () => {
  it("is off without SMTP_HOST", () => {
    vi.stubEnv("SMTP_HOST", "");
    expect(smtpConfigFromEnv()).toBeNull();
    expect(isMailConfigured()).toBe(false);
  });

  it("is on with SMTP_HOST", () => {
    vi.stubEnv("SMTP_HOST", "smtp.example.com");
    expect(isMailConfigured()).toBe(true);
    expect(smtpConfigFromEnv()).toMatchObject({ host: "smtp.example.com", port: 587 });
  });
});
