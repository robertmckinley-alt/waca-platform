import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import {
  getContentItem,
  getContentType,
  getRevision,
  listRevisions,
  type ContentRevisionRow,
} from "@/db/queries";
import {
  Badge,
  DataTable,
  PageHeader,
  Panel,
  type Column,
  buttonClass,} from "@/components/ui";
import { DiffView } from "@/components/content/diff-view";
import { RestoreButton } from "@/components/content/restore-button";
import { editorFields } from "@/lib/content/fields";
import { diffRevisions, summariseDiff } from "@/lib/content/diff";
import { formatDateTime } from "@/lib/format";
import { readInt, readString, type RawSearchParams } from "@/lib/search-params";
import { isContentType } from "../../../shared";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const detail = await getContentItem(id);
  return { title: `History — ${detail?.item.title ?? "Content"}` };
}

/**
 * REVISION HISTORY.
 *
 * Append-only: restoring revision 4 writes revision 9 whose data is a copy of
 * 4's, and says so. Nothing is ever rewound and nothing is ever deleted, so
 * the numbering stays gap-free and the history stays defensible.
 *
 * The comparison is a GET form. Which two revisions you are looking at is
 * part of the URL, so it can be pasted into a message to whoever needs to
 * review it — which is the whole reason anyone opens this page.
 */
export default async function HistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ type: string; id: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const { type, id } = await params;
  if (!isContentType(type)) notFound();

  const sp = await searchParams;
  const page = readInt(sp, "page", 1);

  const detail = await getContentItem(id);
  if (!detail || detail.item.type !== type) notFound();

  const [contentType, revisions] = await Promise.all([
    getContentType(type),
    listRevisions(detail.item.id, { page, pageSize: 50 }),
  ]);
  if (!contentType) notFound();

  const fields = editorFields(contentType.fields);

  // Defaults: what is live, against what is newest — the comparison somebody
  // arriving from the publish queue came here to see.
  //
  // When those are the same revision (nothing is pending) that comparison is
  // empty and useless, so fall back to "the previous version against this
  // one", which is what somebody arriving from the item itself wanted.
  const defaultB = detail.latestRevision?.id ?? null;
  const publishedIsLatest =
    detail.publishedRevision?.id != null &&
    detail.publishedRevision.id === defaultB;
  const defaultA = publishedIsLatest
    ? (revisions.rows.find((r) => r.id !== defaultB)?.id ?? null)
    : (detail.publishedRevision?.id ??
      revisions.rows.find((r) => r.id !== defaultB)?.id ??
      null);

  const aId = readString(sp, "a") ?? defaultA;
  const bId = readString(sp, "b") ?? defaultB;

  const [a, b] = await Promise.all([
    aId ? getRevision(aId) : Promise.resolve(null),
    bId ? getRevision(bId) : Promise.resolve(null),
  ]);

  const valid =
    a?.itemId === detail.item.id || b?.itemId === detail.item.id;

  const diffs =
    b && b.itemId === detail.item.id
      ? diffRevisions(
          fields,
          a && a.itemId === detail.item.id
            ? {
                title: a.title,
                slug: a.slug,
                excerpt: a.excerpt,
                data: a.data,
              }
            : null,
          { title: b.title, slug: b.slug, excerpt: b.excerpt, data: b.data },
        )
      : [];

  const summary = summariseDiff(diffs);

  const columns: Column<ContentRevisionRow>[] = [
    {
      key: "revisionNumber",
      header: "Revision",
      align: "right",
      width: "5rem",
      cell: (row) => (
        <span className="tabular font-medium text-zinc-900">
          v{row.revisionNumber}
        </span>
      ),
    },
    {
      key: "createdAt",
      header: "Saved",
      cell: (row) => (
        <span className="text-zinc-600">{formatDateTime(row.createdAt)}</span>
      ),
    },
    {
      key: "author",
      header: "By",
      cell: (row) => (
        <span className="text-zinc-700">{row.authorLabel ?? "—"}</span>
      ),
    },
    {
      key: "title",
      header: "Title at the time",
      secondary: true,
      cell: (row) => <span className="text-zinc-700">{row.title}</span>,
    },
    {
      key: "summary",
      header: "Note",
      secondary: true,
      cell: (row) => (
        <span className="text-zinc-600">
          {row.summary ??
            (row.restoredFromRevisionId ? "Restored" : <span className="text-zinc-400">—</span>)}
        </span>
      ),
    },
    {
      key: "state",
      header: "",
      cell: (row) =>
        row.isPublished ? <Badge tone="positive">Live</Badge> : null,
    },
    {
      key: "compare",
      header: "Compare",
      align: "right",
      cell: (row) => (
        <span className="flex justify-end gap-2 text-[12px]">
          <Link
            href={`?a=${row.id}&b=${bId ?? ""}`}
            className="text-zinc-600 underline underline-offset-2 hover:text-zinc-900"
          >
            as before
          </Link>
          <Link
            href={`?a=${aId ?? ""}&b=${row.id}`}
            className="text-zinc-600 underline underline-offset-2 hover:text-zinc-900"
          >
            as after
          </Link>
        </span>
      ),
    },
    {
      key: "restore",
      header: "",
      align: "right",
      cell: (row) => (
        <RestoreButton
          itemId={detail.item.id}
          revisionId={row.id}
          revisionNumber={row.revisionNumber}
          disabled={row.id === detail.latestRevision?.id}
        />
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        breadcrumb={[
          { label: "Content", href: "/admin/content" },
          { label: contentType.labelPlural, href: `/admin/content/${type}` },
          {
            label: detail.item.title,
            href: `/admin/content/${type}/${detail.item.id}`,
          },
        ]}
        title="Revision history"
        description={`${detail.revisionCount} revision${
          detail.revisionCount === 1 ? "" : "s"
        }. History is append-only: restoring an old version writes a new revision that says where it came from. Nothing here is ever edited or deleted.`}
      />

      <Panel
        title="Compare"
        description={
          valid
            ? summary.text === "No field changed."
              ? "These two revisions are identical."
              : `Changed: ${summary.text}.`
            : "Pick two revisions."
        }
      >
        <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label
              htmlFor="rev-a"
              className="text-[11px] font-medium uppercase tracking-wide text-zinc-500"
            >
              From
            </label>
            <select
              id="rev-a"
              name="a"
              defaultValue={aId ?? ""}
              className="rounded border border-zinc-200 bg-white px-2 py-1.5 text-[13px]"
            >
              <option value="">Nothing (first version)</option>
              {revisions.rows.map((r) => (
                <option key={r.id} value={r.id}>
                  v{r.revisionNumber} — {formatDateTime(r.createdAt)}
                  {r.isPublished ? " (live)" : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="rev-b"
              className="text-[11px] font-medium uppercase tracking-wide text-zinc-500"
            >
              To
            </label>
            <select
              id="rev-b"
              name="b"
              defaultValue={bId ?? ""}
              className="rounded border border-zinc-200 bg-white px-2 py-1.5 text-[13px]"
            >
              {revisions.rows.map((r) => (
                <option key={r.id} value={r.id}>
                  v{r.revisionNumber} — {formatDateTime(r.createdAt)}
                  {r.isPublished ? " (live)" : ""}
                </option>
              ))}
            </select>
          </div>

          <button type="submit" className={buttonClass("primary")}>
            Compare
          </button>
        </form>

        {b ? (
          <DiffView diffs={diffs} />
        ) : (
          <p className="text-[13px] text-zinc-600">
            This item has no revisions to compare yet.
          </p>
        )}
      </Panel>

      <DataTable
        rows={revisions.rows}
        columns={columns}
        rowKey={(r) => r.id}
        caption={`Revision history for ${detail.item.title}`}
        pathname={`/admin/content/${type}/${detail.item.id}/history`}
        params={sp}
        page={revisions.page}
        pageSize={revisions.pageSize}
        total={revisions.total}
        pageCount={revisions.pageCount}
        emptyTitle="No revisions yet"
        emptyBody="Every save writes one. This item has never been saved."
      />
    </div>
  );
}
