import type { Metadata } from "next";
import Link from "next/link";
import { ownerMeta, ownerT } from "@/server/owner/lang";
import { ResetForm } from "./reset-form";
import "../../onboarding/onboarding.css";

export const generateMetadata = (): Promise<Metadata> => ownerMeta("auth.resetPageTitle");

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function ResetPage({ searchParams }: Props) {
  const { t } = await ownerT();
  const raw = (await searchParams).token;
  const token = typeof raw === "string" ? raw : "";
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
        <h1>{t("auth.newPasswordTitle")}</h1>
        <p>{t("auth.newPasswordSub")}</p>
      </div>
      {token ? (
        <ResetForm token={token} />
      ) : (
        <div className="ob-panel glass">
          <p className="ob-error" role="alert">
            {t("auth.errLink")}
          </p>
          <Link href="/signin/forgot" className="btn">
            {t("auth.requestNew")}
          </Link>
        </div>
      )}
    </main>
  );
}
