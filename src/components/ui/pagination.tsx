import Link from "next/link";
import { cn } from "@/lib/cn";
import { buildHref, type RawSearchParams } from "@/lib/search-params";

/**
 * Server-side pagination. Every list view is paginated in SQL — nothing loads
 * 5,000 rows into the browser and slices them there.
 */
export function Pagination({
  pathname,
  params,
  page,
  pageSize,
  total,
  pageCount,
}: {
  pathname: string;
  params: RawSearchParams;
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}) {
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  const link =
    "rounded border border-zinc-200 px-2 py-1 text-[12px] text-zinc-700 hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900";
  // A real <button disabled>, not a greyed-out <span>. WCAG exempts disabled
  // controls from the contrast minimum; it does not exempt a span that merely
  // looks disabled, and a span also tells assistive tech nothing about why
  // "Previous" does not work on page 1.
  const disabled =
    "rounded border border-zinc-100 px-2 py-1 text-[12px] text-zinc-500";

  return (
    <div className="flex items-center justify-between border-t border-zinc-200 px-3 py-2 text-[12px] text-zinc-500">
      <div className="tabular">
        {first.toLocaleString()}–{last.toLocaleString()} of{" "}
        {total.toLocaleString()}
      </div>
      <div className="flex items-center gap-2">
        <PageSize pathname={pathname} params={params} pageSize={pageSize} />
        <div className="flex items-center gap-1">
          {page > 1 ? (
            <Link
              className={link}
              href={buildHref(pathname, params, { page: page - 1 })}
              rel="prev"
            >
              Previous
            </Link>
          ) : (
            <button type="button" disabled className={disabled}>
              Previous
            </button>
          )}
          <span className="tabular px-1">
            {page} / {Math.max(pageCount, 1)}
          </span>
          {page < pageCount ? (
            <Link
              className={link}
              href={buildHref(pathname, params, { page: page + 1 })}
              rel="next"
            >
              Next
            </Link>
          ) : (
            <button type="button" disabled className={disabled}>
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function PageSize({
  pathname,
  params,
  pageSize,
}: {
  pathname: string;
  params: RawSearchParams;
  pageSize: number;
}) {
  return (
    <div className="flex items-center gap-1">
      <span>Rows</span>
      {[25, 50, 100, 200].map((size) => (
        <Link
          key={size}
          href={buildHref(pathname, params, { pageSize: size, page: null })}
          className={cn(
            "rounded px-1.5 py-0.5 tabular",
            size === pageSize
              ? "bg-zinc-900 text-white"
              : "text-zinc-500 hover:bg-zinc-100",
          )}
        >
          {size}
        </Link>
      ))}
    </div>
  );
}
