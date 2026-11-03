import { describe, expect, it } from "vitest";
import { actionLabel } from "@/server/owner/audit";
import { localizeMessage, translator, type Lang } from "@/shared/owner-copy";

const AUDITED_ACTIONS = [
  "api_key.created",
  "api_key.revoked",
  "business_model.applied",
  "business_model.confirmed",
  "business_model.proposed",
  "change_set.applied",
  "change_set.created",
  "change_set.rejected",
  "conversation.created",
  "conversation.status_changed",
  "inquiry.answered",
  "inquiry.created",
  "inquiry.status_changed",
  "offer.archived",
  "offer.created",
  "offer.price_updated",
  "offer.updated",
  "offer_type.created",
  "offer_type.updated",
  "order.contact_updated",
  "order.created",
  "order.items_updated",
  "order.status_changed",
  "order.submitted",
  "policies.updated",
  "profile.updated",
  "proposal_run.started",
  "source_asset.uploaded",
  "staff.invited",
  "staff.removed",
  "tenant.created",
  "tenant.provisioned",
  "tenant.status_changed",
  "user.created",
  "user.password_changed",
  "user.password_reset",
  "user.password_reset_requested",
  "user.sessions_revoked",
];

const LANGS: Lang[] = ["en", "ru", "kk"];

describe("audit action labels", () => {
  it.each(LANGS)("label every audited action in %s", (lang) => {
    for (const action of AUDITED_ACTIONS) {
      expect(actionLabel(action, lang), `${lang} ${action}`).not.toBe(action);
    }
  });
});

describe("sign-in and agent copy", () => {
  it.each(LANGS)("defines the credential errors and config button in %s", (lang) => {
    const { t } = translator(lang);
    for (const key of [
      "auth.enterCredentials",
      "auth.wrongCredentials",
      "auth.tooMany",
      "ag.copyConfig",
    ] as const) {
      expect(t(key), `${lang} ${key}`).not.toBe(key);
    }
  });

  it("does not leave the sign-in errors in English for Russian and Kazakh", () => {
    for (const lang of ["ru", "kk"] as const) {
      const { t } = translator(lang);
      expect(t("auth.wrongCredentials")).not.toBe("The email or password is not right.");
      expect(t("auth.enterCredentials")).not.toBe("Enter your email and password.");
    }
  });

  it("translates the status inside the change set message", () => {
    expect(localizeMessage("ru", "Change set is already applied")).not.toMatch(/applied/);
  });
});
