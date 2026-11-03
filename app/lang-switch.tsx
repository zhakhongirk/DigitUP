import { translator, type Lang } from "@/shared/owner-copy";
import { setLanguage } from "./lang-actions";

const OPTIONS = [
  ["en", "lang.en"],
  ["ru", "lang.ru"],
] as const;

export function LangSwitch({ lang, className }: { lang: Lang; className?: string }) {
  const { t } = translator(lang);
  return (
    <form
      action={setLanguage}
      className={`segmented segmented-sm lang-switch${className ? ` ${className}` : ""}`}
      role="group"
      aria-label={t("lang.label")}
    >
      {OPTIONS.map(([value, label]) => (
        <button
          key={value}
          type="submit"
          name="lang"
          value={value}
          aria-pressed={value === lang}
          lang={value}
        >
          {t(label)}
        </button>
      ))}
    </form>
  );
}
