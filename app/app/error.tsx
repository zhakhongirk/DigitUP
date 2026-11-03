"use client";

export default function AppError({ reset }: { reset: () => void }) {
  return (
    <section className="ib-empty glass" role="alert">
      <h2>Something went wrong</h2>
      <p>Try again. If this keeps happening, reload the page.</p>
      <button type="button" className="btn" onClick={() => reset()}>
        Try again
      </button>
    </section>
  );
}
