"use client";

import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { translator, type Lang, type Translator } from "@/shared/owner-copy";

const LangContext = createContext<Lang>("en");

export function LangProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return <LangContext.Provider value={lang}>{children}</LangContext.Provider>;
}

export function useT(): Translator {
  const lang = useContext(LangContext);
  return useMemo(() => translator(lang), [lang]);
}
