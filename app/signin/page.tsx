import type { Metadata } from "next";
import Link from "next/link";
import { ownerMeta, ownerT } from "@/server/owner/lang";
import { SignInForm } from "./signin-form";
import "../onboarding/onboarding.css";

export const generateMetadata = (): Promise<Metadata> => ownerMeta("auth.pageTitle");

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function SignInPage({ searchParams }: Props) {
  const params = await searchParams;
  const next = params.next;
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
        <h1>{t("auth.welcome")}</h1>
        <p>{t("auth.welcomeSub")}</p>
      </div>
      {params.reset === "1" ? (
        <p className="ob-note" role="status">
          {t("auth.resetDone")}
        </p>
      ) : null}
      <SignInForm next={typeof next === "string" ? next : "/app"} />
      <p className="ob-hint">
        {t("auth.newHere")}
        <Link href="/onboarding">{t("auth.setUp")}</Link>
      </p>
    </main>
  );
}
