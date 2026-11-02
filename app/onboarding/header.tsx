import Link from "next/link";

const STEPS = ["Describe", "Review", "Launch"] as const;

export function OnboardingHeader({ step }: { step: 1 | 2 | 3 }) {
  return (
    <div className="ob-top">
      <Link href="/" className="ob-logo">
        <span className="ob-logo-mark" aria-hidden="true">
          AS
        </span>
        Agentic Storefront
      </Link>
      <ol className="ob-steps" aria-label="Setup progress">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const done = n < step;
          return (
            <li
              key={label}
              className={done ? "ob-step-done" : undefined}
              aria-current={n === step ? "step" : undefined}
            >
              {done ? "✓" : n} {label}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
