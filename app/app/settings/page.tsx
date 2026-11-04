import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { tenants } from "@/db/schema";
import { getServices } from "@/server/container";
import { LangSwitch } from "@/app/lang-switch";
import { defaultCoverService, isImageGenerationConfigured } from "@/server/media/cover";
import { ownerMeta, ownerT } from "@/server/owner/lang";
import { ownerOnly } from "@/server/owner/access";
import { currentOwner } from "@/server/owner/session";
import {
  CoverPanel,
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

  const [model, telegram, cover, [tenant]] = await Promise.all([
    services.catalog.getBusinessModel(owner),
    services.telegram.status(owner),
    defaultCoverService().get(owner.tenantId),
    getDb().select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, owner.tenantId)),
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
        <CoverPanel
          available={isImageGenerationConfigured()}
          coverUrl={cover && tenant ? `/s/${tenant.slug}/cover?v=${cover.version}` : null}
        />
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
