import type { Metadata } from "next";
import Link from "next/link";
import { t } from "@/server/storefront/i18n";
import { storefrontLang } from "../lang";
import { LookupForm } from "./lookup-form";
import "./my-order.css";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export const metadata: Metadata = { title: "My order", robots: { index: false } };

export default async function MyOrderPage({ params }: Props) {
  const { slug } = await params;
  const lang = await storefrontLang();
  return (
    <article className="mo">
      <Link href={`/s/${slug}`} className="sf-back">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          aria-hidden="true"
        >
          <path d="M15 5l-7 7 7 7" />
        </svg>
        {t(lang, "backToCatalog")}
      </Link>
      <section className="mo-panel glass" aria-labelledby="mo-title">
        <h1 id="mo-title">{t(lang, "myOrder")}</h1>
        <p className="mo-lead">{t(lang, "lookupIntro")}</p>
        <LookupForm
          slug={slug}
          labels={{
            number: t(lang, "lookupNumber"),
            numberHint: t(lang, "lookupNumberHint"),
            phone: t(lang, "lookupPhone"),
            phoneHint: t(lang, "lookupPhoneHint"),
            submit: t(lang, "lookupSubmit"),
          }}
        />
      </section>
    </article>
  );
}
