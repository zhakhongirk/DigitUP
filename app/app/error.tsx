"use client";

import { useT } from "@/app/i18n-provider";

export default function AppError({ reset }: { reset: () => void }) {
  const { t } = useT();
  return (
    <section className="ib-empty glass" role="alert">
      <h2>{t("common.errorTitle")}</h2>
      <p>{t("common.errorBody")}</p>
      <button type="button" className="btn" onClick={() => reset()}>
        {t("common.tryAgain")}
      </button>
    </section>
  );
}
