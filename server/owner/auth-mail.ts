import type { Mail } from "@/server/mail";
import { tr, type Lang } from "@/shared/owner-copy";

export function resetPath(token: string): string {
  return `/signin/reset?token=${encodeURIComponent(token)}`;
}

export function resetMail(lang: Lang, to: string, baseUrl: string, token: string): Mail {
  const link = `${baseUrl}${resetPath(token)}`;
  return {
    to,
    link,
    subject: tr(lang, "mail.resetSubject"),
    text: tr(lang, "mail.resetBody", { link }),
  };
}

export function inviteMail(
  lang: Lang,
  to: string,
  baseUrl: string,
  token: string,
  store: string,
): Mail {
  const link = `${baseUrl}${resetPath(token)}`;
  return {
    to,
    link,
    subject: tr(lang, "mail.inviteSubject", { store }),
    text: tr(lang, "mail.inviteBody", { store, link }),
  };
}
