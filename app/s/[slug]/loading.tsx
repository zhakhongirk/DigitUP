import { t } from "@/server/storefront/i18n";
import { storefrontLang } from "./lang";

export default async function Loading() {
  const lang = await storefrontLang();
  return (
    <div aria-busy="true" aria-label={t(lang, "loadingCatalog")}>
      <section className="sf-hero">
        <div className="sf-skel sf-skel-title" />
        <div className="sf-skel sf-skel-line" />
      </section>
      <div className="sf-skel sf-skel-search" />
      <ul className="sf-grid sf-skel-grid">
        {Array.from({ length: 8 }, (_, i) => (
          <li key={i} className="sf-card">
            <div className="sf-skel sf-card-media" />
            <div className="sf-skel sf-skel-line" />
            <div className="sf-skel sf-skel-line sf-skel-short" />
          </li>
        ))}
      </ul>
    </div>
  );
}
