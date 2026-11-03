import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { LangSwitch } from "@/app/lang-switch";
import { ownerMeta, ownerT } from "@/server/owner/lang";
import { ownerOnly } from "@/server/owner/access";
import { currentOwner } from "@/server/owner/session";
import {
  PasswordForm,
  PoliciesForm,
  ProfileForm,
  SignOutEverywhereForm,
  TelegramPanel,
} from "./settings-forms";
import { StaffSection } from "./staff-section";
import "./settings.css";

export const generateMetadata = (): Promise<Metadata> => ownerMeta("nav.settings");

export default async function SettingsPage() {
  const services = await getServices();
  const [{ t, lang }, owner] = await Promise.all([ownerT(), currentOwner(services)]);
  if (!owner) redirect("/signin?next=/app/settings");
  ownerOnly(owner);

  const [model, telegram] = await Promise.all([
    services.catalog.getBusinessModel(owner),
    services.telegram.status(owner),
  ]);

  return (
    <>
      <div className="ws-title">
        <h1>{t("st.title")}</h1>
        <p className="ws-sub">{t("st.sub")}</p>
      </div>
      <div className="st-stack">
        <section className="st-panel glass" aria-labelledby="st-language">
          <h2 id="st-language">{t("st.language")}</h2>
          <p>{t("st.languageBody")}</p>
          <LangSwitch lang={lang} />
        </section>
        <ProfileForm profile={model.profile} />
        <PoliciesForm policies={model.policies} />
        <TelegramPanel
          status={{
            configured: telegram.configured,
            connected: telegram.connected,
            linkUrl: telegram.link?.url ?? null,
          }}
        />
        <StaffSection owner={owner} />
        <PasswordForm />
        <SignOutEverywhereForm />
      </div>
    </>
  );
}
