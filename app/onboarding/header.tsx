import Link from "next/link";
import { LangSwitch } from "@/app/lang-switch";
import { ownerT } from "@/server/owner/lang";

const STEPS = ["ob.stepDescribe", "ob.stepReview", "ob.stepLaunch"] as const;

export async function OnboardingHeader({ step }: { step: 1 | 2 | 3 }) {
  const { t, lang } = await ownerT();
  return (
    <div className="ob-top">
      <Link href="/" className="ob-logo">
        <span className="ob-logo-mark" aria-hidden="true">
          AS
        </span>
        {t("auth.brand")}
      </Link>
      <LangSwitch lang={lang} />
      <ol className="ob-steps" aria-label={t("ob.stepsLabel")}>
        {STEPS.map((label, i) => {
          const n = i + 1;
          const done = n < step;
          return (
            <li
              key={label}
              className={done ? "ob-step-done" : undefined}
              aria-current={n === step ? "step" : undefined}
            >
              {done ? "✓" : n} {t(label)}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
