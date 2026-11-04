import nodemailer from "nodemailer";
import { log } from "../log";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  /** Link to print instead of sending when SMTP is not configured. */
  link: string;
}

interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
}

export function smtpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpConfig | null {
  const host = env.SMTP_HOST?.trim();
  if (!host) return null;
  const port = Number.parseInt(env.SMTP_PORT ?? "", 10);
  const user = env.SMTP_USER?.trim();
  return {
    host,
    port: Number.isInteger(port) && port > 0 ? port : 587,
    user: user || undefined,
    pass: env.SMTP_PASS || undefined,
    from: env.SMTP_FROM?.trim() || user || "no-reply@localhost",
  };
}

export function isMailConfigured(): boolean {
  return smtpConfigFromEnv() !== null;
}

/** Sends through SMTP, or logs the link when SMTP_HOST is unset. */
export async function sendMail(mail: Mail): Promise<void> {
  const config = smtpConfigFromEnv();
  if (!config) {
    log.info("mail.not_sent", { to: mail.to, subject: mail.subject, link: mail.link });
    return;
  }
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
  });
  await transport.sendMail({
    from: config.from,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
  });
}

/** Sends in the background so response time does not reveal whether an account exists. */
export function sendMailInBackground(mail: Mail): void {
  sendMail(mail).catch((error: unknown) => {
    log.error("mail.failed", { to: mail.to, error });
  });
}
