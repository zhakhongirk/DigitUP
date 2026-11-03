import type { ReactNode } from "react";
import { LangProvider } from "@/app/i18n-provider";
import { ownerLang } from "@/server/owner/lang";

export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  return <LangProvider lang={await ownerLang()}>{children}</LangProvider>;
}
