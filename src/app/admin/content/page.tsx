import Link from "next/link";
import type { Metadata } from "next";

import {
  CONTENT_STATUSES,
  getContentCounts,
  listContent,
  listContentTypes,
  type ContentListRow,
  type ContentStatus,
  type ContentTypeKey,
} from "@/db/queries";
import {
  Badge,
  DataTable,
  EmptyState,
  FilterBar,
  LinkButton,
  PageHeader,
  Panel,
  StatTile,
  Tabs,
  type Column,
  type FilterField,
} from "@/components/ui";
import { formatDateTime, humanize } from "@/lib/format";
import {
  readEnumArray,
  readInt,
  readString,
  type RawSearchParams,
} from "@/lib/search-params";
import { CONTENT_TABS, CONTENT_TYPE_KEYS } from "./shared";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Content" };

const STATUS_TONE: Record<ContentStatus, "neutral" | "positive" | "warning" | "muted"> =
  {
    draft: "muted",
    in_review: "warning",
    scheduled: "warning",
    published: "positive",
    archived: "muted",
  };

/**
 * ALL CONTENT.
 *
 * Unfiltered, it is grouped by collection — ten panels, most recent first in
 * each, with a link through to the full collection. That is how staff think
 * about this ("where do press releases live?"), and a single flat list of 105
 * rows sorted by date answers a question nobody asks.
 *
 * The moment a filter or a search is applied it becomes one flat, paginated
 * table, because at that point the user has told us what they are looking for
 * and grouping gets in the way.
 */
export default async function ContentIndexPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const sp = await searchParams;
  const types = readEnumArray<ContentTypeKey>(sp, "type", CONTENT_TYPE_KEYS);
  const statuses = readEnumArray<ContentStatus>(sp, "status", CONTENT_STATUSES);
  const search = readString(sp, "q");
  const page = readInt(sp, "page", 1);

  const filtered = types.length > 0 || statuses.length > 0 || Boolean(search);

  const [counts, contentTypes] = await Promise.all([
    getContentCounts(),
    listContentTypes(),
  ]);
  const typeByKey = new Map(contentTypes.map((t) => [t.key, t]));

  const fields: FilterField[] = [
    { kind: "search", name: "q", placeholder: "Title, slug or summary" },
    {
      kind: "multi",
      name: "type",
      label: "Collection",
      options: contentTypes.map((t) => ({
        value: t.key,
        label: t.labelPlural,
      })),
    },
    {
      kind: "multi",
      name: "status",
      label: "Status",
      options: CONTENT_STATUSES.map((s) => ({
        value: s,
        label: humanize(s),
      })),
    },
  ];

  const columns: Column<ContentListRow>[] = [
    {
      key: "title",
      header: "Item",
      sortable: true,
      cell: (row) => (
        <div className="min-w-0">
          <Link
            href={`/admin/content/${row.type}/${row.id}`}
            className="font-medium text-zinc-900 underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-900"
          >
            {row.title}
          </Link>
          <div className="truncate text-[11px] text-zinc-500">/{row.slug}</div>
        </div>
      ),
    },
    {
      key: "type",
      header: "Collection",
      secondary: true,
      cell: (row) => (
        <Link
          href={`/admin/content/${row.type}`}
          className="text-zinc-600 hover:text-zinc-900"
        >
          {typeByKey.get(row.type)?.label ?? row.type}
        </Link>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1">
          <Badge tone={STATUS_TONE[row.status]}>{humanize(row.status)}</Badge>
          {row.hasUnpublishedChanges ? (
            <Badge tone="warning">Unpublished changes</Badge>
          ) : null}
        </span>
      ),
    },
    {
      key: "updatedAt",
      header: "Last edited",
      sortable: true,
      defaultDirection: "desc",
      cell: (row) => (
        <span className="text-zinc-600">{formatDateTime(row.updatedAt)}</span>
      ),
    },
    {
      key: "by",
      header: "By",
      secondary: true,
      cell: (row) => (
        <span className="text-zinc-600">{row.lastEditedBy ?? "—"}</span>
      ),
    },
  ];

  const grouped = filtered
    ? null
    : await Promise.all(
        contentTypes.map(async (t) => ({
          type: t,
          page: await listContent({
            type: t.key,
            pageSize: 6,
            sort: "updatedAt",
            direction: "desc",
          }),
        })),
      );

  const flat = filtered
    ? await listContent({
        type: types.length ? types : undefined,
        status: statuses.length ? statuses : undefined,
        search,
        page,
        pageSize: 50,
        sort: "updatedAt",
        direction: "desc",
      })
    : null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Content"
        description={
          <>
            Everything the public site is built from. Postgres is the source of
            truth here; the site fetches a published snapshot at build time and
            Publish rebuilds it.
          </>
        }
        actions={
          <LinkButton href="/admin/content/publish" variant="primary">
            Publish queue
            {counts.pendingPublish ? ` (${counts.pendingPublish})` : ""}
          </LinkButton>
        }
      />

      <Tabs items={CONTENT_TABS} label="Content sections" />

      {/* The number this page exists to surface. */}
      {counts.pendingPublish > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3">
          <div>
            <p className="text-[15px] font-semibold text-amber-900">
              {counts.pendingPublish} item
              {counts.pendingPublish === 1 ? "" : "s"} changed since the last
              publish
            </p>
            <p className="mt-0.5 text-[12px] text-amber-900/90">
              None of it is on the public site yet.{" "}
              {counts.lastPublishAt
                ? `Last published ${formatDateTime(counts.lastPublishAt)}.`
                : "Nothing has been published from here yet."}
            </p>
          </div>
          <LinkButton href="/admin/content/publish" variant="primary" size="md">
            Review and publish them together
          </LinkButton>
        </div>
      ) : (
        <div className="rounded-md border border-zinc-200 bg-zinc-50 px-4 py-3 text-[13px] text-zinc-700">
          Nothing is waiting to be published. The public site matches this
          database as of{" "}
          {counts.lastPublishAt
            ? formatDateTime(counts.lastPublishAt)
            : "its last build"}
          .
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile
          label="Published"
          value={counts.byStatus.published}
          sub="live on the site"
        />
        <StatTile
          label="Draft"
          value={counts.byStatus.draft}
          sub="not yet reviewed"
        />
        <StatTile
          label="In review"
          value={counts.byStatus.in_review}
          sub="waiting on somebody"
        />
        <StatTile
          label="Scheduled"
          value={counts.byStatus.scheduled}
          sub="queued to go live"
        />
        <StatTile
          label="Archived"
          value={counts.byStatus.archived}
          sub="taken down"
        />
      </div>

      <FilterBar pathname="/admin/content" params={sp} fields={fields} />

      {flat ? (
        <DataTable
          rows={flat.rows}
          columns={columns}
          rowKey={(r) => r.id}
          caption="Content matching the current filters"
          pathname="/admin/content"
          params={sp}
          page={flat.page}
          pageSize={flat.pageSize}
          total={flat.total}
          pageCount={flat.pageCount}
          sort="updatedAt"
          direction="desc"
          emptyTitle="Nothing matches those filters"
          emptyBody="Try a different collection, or clear the search."
        />
      ) : null}

      {grouped
        ? grouped.map(({ type, page: rows }) => (
            <Panel
              key={type.key}
              title={type.labelPlural}
              description={type.description ?? undefined}
              actions={
                <span className="flex items-center gap-2">
                  <Link
                    href={`/admin/content/${type.key}`}
                    className="text-[12px] text-zinc-600 underline underline-offset-2 hover:text-zinc-900"
                  >
                    All {rows.total}
                  </Link>
                  {type.allowsCreate ? (
                    <LinkButton href={`/admin/content/${type.key}/new`}>
                      New
                    </LinkButton>
                  ) : null}
                </span>
              }
              bodyClassName="p-0"
            >
              {rows.rows.length ? (
                <DataTable
                  rows={rows.rows}
                  columns={columns.filter((c) => c.key !== "type")}
                  rowKey={(r) => r.id}
                  caption={`Most recently edited ${type.labelPlural.toLowerCase()}`}
                />
              ) : (
                <div className="p-3">
                  <EmptyState title={`No ${type.labelPlural.toLowerCase()} yet`}>
                    {type.allowsCreate
                      ? "Nothing has been created in this collection."
                      : "This collection is maintained elsewhere and has nothing in it yet."}
                  </EmptyState>
                </div>
              )}
            </Panel>
          ))
        : null}
    </div>
  );
}
