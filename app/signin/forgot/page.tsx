import type { Metadata } from "next";
import Link from "next/link";
import { isMailConfigured } from "@/server/mail";
import { ownerMeta, ownerT } from "@/server/owner/lang";
import { ForgotForm } from "./forgot-form";
import "../../onboarding/onboarding.css";

export const generateMetadata = (): Promise<Metadata> => ownerMeta("auth.forgotPageTitle");

export default async function ForgotPage() {
  const { t } = await ownerT();
  return (
    <main className="ob-root ob-root-signin">
      <div className="ob-top">
        <Link href="/" className="ob-logo">
          <span className="ob-logo-mark" aria-hidden="true">
            AS
          </span>
          {t("auth.brand")}
        </Link>
      </div>
      <div className="ob-intro">
        <h1>{t("auth.forgotTitle")}</h1>
        <p>{t("auth.forgotSub")}</p>
      </div>
      {isMailConfigured() ? null : <p className="ob-hint">{t("auth.mailOff")}</p>}
      <ForgotForm />
      <p className="ob-hint">
        <Link href="/signin">{t("auth.backToSignIn")}</Link>
      </p>
    </main>
  );
}
