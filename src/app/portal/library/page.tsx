import Link from "next/link";

import { Pager } from "@/components/portal/pager";
import {
  ActionLink,
  EmptyState,
  PageIntro,
  Pill,
  Row,
  Rows,
  Section,
} from "@/components/portal/ui";
import { listDocumentsFor, type DocumentCategory } from "@/db/queries";
import { getLibraryFacets } from "@/lib/documents/facets";
import {
  ACCESS_SCOPE_LABELS,
  DOCUMENT_CATEGORIES,
  DOCUMENT_CATEGORY_LABELS,
  formatBytes,
} from "@/lib/documents/labels";
import { documentDownloadHref } from "@/lib/documents/signed-url";
import { formatDate, humanize } from "@/lib/format";
import { requirePortal } from "@/lib/portal/session";
import {
  buildHref,
  readEnumArray,
  readInt,
  readString,
  type RawSearchParams,
} from "@/lib/search-params";

export const metadata = { title: "Document library" };
export const dynamic = "force-dynamic";

/**
 * THE DOCUMENT LIBRARY.
 *
 * 461 MB sits in Wild Apricot that members cannot get at, including the weekly
 * "MM.DD.YY WACA Detail Report w/ Upcoming" bill-tracking files. This page is
 * the reason a member logs in.
 *
 * ACCESS IS NOT ENFORCED HERE. Every row on this page came out of
 * listDocumentsFor(viewer, …), which applies the scope predicate in SQL; this
 * component filters nothing and hides nothing. Two consequences worth stating:
 *   · the result count, the facet menus and the pagination are all already
 *     scoped, so nothing leaks through a count or a page number either;
 *   · `fileKey` is never rendered. The only way to bytes is a per-render,
 *     expiring, viewer-bound token that the download route re-checks.
 */
export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const { data, viewer } = await requirePortal();
  const sp = await searchParams;

  const search = readString(sp, "q");
  const categories = readEnumArray(sp, "category", DOCUMENT_CATEGORIES);
  const yearParam = readString(sp, "year");
  const policyYear = yearParam && /^\d{4}$/.test(yearParam) ? Number(yearParam) : undefined;
  const page = readInt(sp, "page", 1);

  const [facets, results] = await Promise.all([
    getLibraryFacets(viewer),
    listDocumentsFor(viewer, {
      search,
      categories: categories.length ? (categories as DocumentCategory[]) : undefined,
      policyYear,
      page,
      pageSize: 20,
      sort: "publishedOn",
      direction: "desc",
    }),
  ]);

  const filtered = Boolean(search || categories.length || policyYear);
  const availableCategories = facets.categories.filter((c) => c.count > 0);

  return (
    <>
      <PageIntro
        eyebrow="Library"
        title="Documents"
        lede={
          <>
            Weekly legislative Detail Reports, legislative and regulatory
            agendas, testimony, comment letters, position papers and event
            materials. {facets.total}{" "}
            {facets.total === 1 ? "document is" : "documents are"} released to
            you. Newest first.
          </>
        }
      />

      <form
        method="get"
        action="/portal/library"
        className="border-y border-zinc-200 py-5"
        role="search"
        aria-label="Search the document library"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:gap-5">
          <div className="flex flex-1 flex-col gap-1.5">
            <label
              htmlFor="library-q"
              className="text-[13px] font-medium text-zinc-800"
            >
              Search titles and descriptions
            </label>
            <input
              id="library-q"
              name="q"
              type="search"
              defaultValue={search ?? ""}
              placeholder="e.g. detail report, HB 1341, testimony"
              className="w-full rounded-sm border border-zinc-300 px-3 py-2 text-[15px] text-zinc-900 placeholder:text-zinc-500 focus:border-zinc-900"
            />
          </div>

          {facets.years.length ? (
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="library-year"
                className="text-[13px] font-medium text-zinc-800"
              >
                Policy year
              </label>
              <select
                id="library-year"
                name="year"
                defaultValue={policyYear ? String(policyYear) : ""}
                className="rounded-sm border border-zinc-300 px-3 py-2 text-[15px] text-zinc-900 focus:border-zinc-900"
              >
                <option value="">All years</option>
                {facets.years.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {categories.map((c) => (
            <input key={c} type="hidden" name="category" value={c} />
          ))}

          <button
            type="submit"
            className="inline-flex items-center justify-center rounded-sm bg-zinc-900 px-4 py-2 text-[14px] font-medium text-white hover:bg-zinc-800"
          >
            Search
          </button>
        </div>
      </form>

      {availableCategories.length ? (
        <nav aria-label="Filter by category" className="mt-5">
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            <li>
              <Link
                href={buildHref("/portal/library", sp, { category: null, page: null })}
                aria-current={categories.length === 0 ? "true" : undefined}
                className={
                  categories.length === 0
                    ? "text-[14px] font-medium text-zinc-900 underline underline-offset-4"
                    : "portal-link text-[14px] text-zinc-600"
                }
              >
                All categories
              </Link>
            </li>
            {availableCategories.map(({ category, count }) => {
              const active = categories.includes(category);
              return (
                <li key={category}>
                  <Link
                    href={buildHref("/portal/library", sp, {
                      category: active ? null : category,
                      page: null,
                    })}
                    aria-current={active ? "true" : undefined}
                    className={
                      active
                        ? "text-[14px] font-medium text-zinc-900 underline underline-offset-4"
                        : "portal-link text-[14px] text-zinc-600"
                    }
                  >
                    {DOCUMENT_CATEGORY_LABELS[category]}{" "}
                    <span className="tabular text-zinc-500">{count}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}

      <Section
        title={
          filtered
            ? `${results.total} ${results.total === 1 ? "match" : "matches"}`
            : "All documents"
        }
        className="mt-10"
        actions={
          filtered ? (
            <ActionLink href="/portal/library">Clear filters</ActionLink>
          ) : undefined
        }
      >
        {results.rows.length ? (
          <>
            <Rows>
              {results.rows.map((doc) => (
                <Row key={doc.id} className="py-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                    <h3 className="font-serif text-[18px] leading-snug text-zinc-900">
                      {doc.title}
                    </h3>
                    <p className="tabular text-[13px] text-zinc-500">
                      {formatDate(doc.publishedOn)}
                    </p>
                  </div>

                  {doc.description ? (
                    <p className="portal-copy mt-2 text-[14px] text-zinc-600">
                      {doc.description}
                    </p>
                  ) : null}

                  <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                    <Pill tone="quiet">
                      {DOCUMENT_CATEGORY_LABELS[doc.category] ?? humanize(doc.category)}
                    </Pill>
                    {doc.accessScope !== "public" ? (
                      <Pill tone="neutral">
                        {ACCESS_SCOPE_LABELS[doc.accessScope] ?? humanize(doc.accessScope)}
                      </Pill>
                    ) : null}
                    {doc.policyYear ? (
                      <span className="text-[13px] text-zinc-500">
                        {doc.policyYear} session
                      </span>
                    ) : null}
                    {doc.relatedBills?.length ? (
                      <span className="text-[13px] text-zinc-500">
                        {doc.relatedBills.slice(0, 6).join(", ")}
                        {doc.relatedBills.length > 6 ? "…" : ""}
                      </span>
                    ) : null}
                  </div>

                  <p className="mt-3 flex flex-wrap items-baseline gap-x-3 text-[13px] text-zinc-500">
                    <ActionLink
                      href={documentDownloadHref(doc.id, viewer.contactId)}
                      download
                    >
                      Download
                    </ActionLink>
                    <span>
                      {doc.fileName.split(".").pop()?.toUpperCase() ?? "FILE"} ·{" "}
                      {formatBytes(doc.bytes)}
                      {doc.pages ? ` · ${doc.pages} pages` : ""}
                    </span>
                  </p>
                </Row>
              ))}
            </Rows>
            <Pager
              pathname="/portal/library"
              searchParams={sp}
              page={results.page}
              pageCount={results.pageCount}
              total={results.total}
              noun="document"
            />
          </>
        ) : filtered ? (
          <EmptyState title="Nothing matches those filters.">
            <p>
              Try a shorter search term — titles follow WACA&rsquo;s own naming,
              so &ldquo;detail report&rdquo; finds the weekly bill tracker and a
              bill number such as &ldquo;HB 1341&rdquo; finds the papers that
              reference it.
            </p>
            <p className="mt-4">
              <ActionLink href="/portal/library" variant="outline">
                Clear filters
              </ActionLink>
            </p>
          </EmptyState>
        ) : (
          <EmptyState title="No documents are released to you yet.">
            <p>
              Access follows scope: some papers are public, most are for members
              in good standing, a few are tied to a membership level or to a
              sector council.{" "}
              {data.membership?.status === "active"
                ? "Your membership is active, so this is simply an empty shelf — the first Detail Report of the session will land here."
                : "Once your membership is back in good standing the members-only material, including the weekly Detail Reports, appears here."}
            </p>
          </EmptyState>
        )}
      </Section>
    </>
  );
}
