import type { Metadata } from "next";
import Link from "next/link";
import { SignInForm } from "./signin-form";
import "../onboarding/onboarding.css";

export const metadata: Metadata = { title: "Sign in" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function SignInPage({ searchParams }: Props) {
  const next = (await searchParams).next;
  return (
    <main className="ob-root" style={{ maxWidth: 460 }}>
      <div className="ob-top">
        <Link href="/" className="ob-logo">
          <span className="ob-logo-mark" aria-hidden="true">
            AS
          </span>
          Agentic Storefront
        </Link>
      </div>
      <div className="ob-intro">
        <h1>Welcome back.</h1>
        <p>Sign in to manage your store.</p>
      </div>
      <SignInForm next={typeof next === "string" ? next : "/app"} />
      <p className="ob-hint">
        New here? <Link href="/onboarding">Set up a store</Link>
      </p>
    </main>
  );
}
