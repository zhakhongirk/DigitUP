import Link from "next/link";
import "./pager.css";

function Step({ href, label, rel }: { href: string | null; label: string; rel?: "prev" | "next" }) {
  return href ? (
    <Link className="btn btn-secondary btn-sm" href={href} rel={rel}>
      {label}
    </Link>
  ) : (
    <span className="btn btn-secondary btn-sm" aria-disabled="true">
      {label}
    </span>
  );
}

export function Pager({
  page,
  pageCount,
  href,
  newerHref,
  olderHref,
}: {
  page: number;
  pageCount: number;
  /** Link to a page number. Ignored for a direction whose explicit link is given. */
  href?: (page: number) => string;
  /** Explicit links for cursor paging; null disables the button. */
  newerHref?: string | null;
  olderHref?: string | null;
}) {
  if (pageCount <= 1) return null;
  const newer = newerHref !== undefined ? newerHref : page > 1 && href ? href(page - 1) : null;
  const older =
    olderHref !== undefined ? olderHref : page < pageCount && href ? href(page + 1) : null;
  return (
    <nav className="pager" aria-label="Pages">
      <Step href={newer} label={newerHref !== undefined ? "Newest" : "Newer"} rel="prev" />
      <span className="pager-status">
        Page {page} of {pageCount}
      </span>
      <Step href={older} label="Older" rel="next" />
    </nav>
  );
}
