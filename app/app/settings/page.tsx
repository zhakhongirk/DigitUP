import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { currentOwner } from "@/server/owner/session";
import { PasswordForm, PoliciesForm, ProfileForm, SignOutEverywhereForm } from "./settings-forms";
import "./settings.css";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/settings");

  const model = await services.catalog.getBusinessModel(owner);

  return (
    <>
      <div className="ws-title">
        <h1>Settings</h1>
        <p className="ws-sub">What shoppers and agents see about your store.</p>
      </div>
      <div className="st-stack">
        <ProfileForm profile={model.profile} />
        <PoliciesForm policies={model.policies} />
        <PasswordForm />
        <SignOutEverywhereForm />
      </div>
    </>
  );
}
