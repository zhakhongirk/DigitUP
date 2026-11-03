import { t } from "@/server/storefront/i18n";
import { storefrontLang } from "./lang";

export default async function StoreNotFound() {
  const lang = await storefrontLang();
  return (
    <section className="sf-empty sf-not-found glass">
      <h1>{t(lang, "storeNotFound")}</h1>
      <p>{t(lang, "storeNotFoundBody")}</p>
    </section>
  );
}
