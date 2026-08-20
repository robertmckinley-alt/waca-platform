import Link from "next/link";

import { buildHref, type RawSearchParams } from "@/lib/search-params";

/**
 * Prev / next paging. Two real links and a plain-language position, rather
 * than a strip of numbered buttons: on a phone the numbers are unhittable and
 * nobody jumps to page 7 of their own invoices.
 */
export function Pager({
  pathname,
  searchParams,
  page,
  pageCount,
  total,
  noun,
}: {
  pathname: string;
  searchParams: RawSearchParams;
  page: number;
  pageCount: number;
  total: number;
  noun: string;
}) {
  if (pageCount <= 1) {
    return total > 0 ? (
      <p className="mt-6 text-[13px] text-zinc-500">
        {total} {total === 1 ? noun : `${noun}s`}
      </p>
    ) : null;
  }

  return (
    <nav
      aria-label={`${noun} pages`}
      className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t border-zinc-200 pt-4"
    >
      <p className="text-[13px] text-zinc-500">
        Page {page} of {pageCount} · {total} {total === 1 ? noun : `${noun}s`}
      </p>
      <div className="flex items-center gap-5">
        {page > 1 ? (
          <Link
            href={buildHref(pathname, searchParams, { page: page - 1 })}
            className="portal-link text-[14px]"
            rel="prev"
          >
            Previous
          </Link>
        ) : (
          <span className="text-[14px] text-zinc-500">Previous</span>
        )}
        {page < pageCount ? (
          <Link
            href={buildHref(pathname, searchParams, { page: page + 1 })}
            className="portal-link text-[14px]"
            rel="next"
          >
            Next
          </Link>
        ) : (
          <span className="text-[14px] text-zinc-500">Next</span>
        )}
      </div>
    </nav>
  );
}
