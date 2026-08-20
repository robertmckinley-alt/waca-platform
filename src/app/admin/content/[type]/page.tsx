import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import {
  CONTENT_STATUSES,
  getContentType,
  listContent,
  type ContentListRow,
  type ContentStatus,
} from "@/db/queries";
import {
  Badge,
  DataTable,
  FilterBar,
  LinkButton,
  PageHeader,
  Panel,
  type Column,
  type FilterField,
} from "@/components/ui";
import { editorFields } from "@/lib/content/fields";
import { FIELD_KIND_NOTES } from "@/lib/content/fields";
import { SITE_TARGETS } from "@/lib/content/site-schemas";
import { formatDateTime, humanize } from "@/lib/format";
import {
  readEnumArray,
  readInt,
  readString,
  type RawSearchParams,
} from "@/lib/search-params";
import { isContentType, liveUrlFor } from "../shared";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<ContentStatus, "neutral" | "positive" | "warning" | "muted"> =
  {
    draft: "muted",
    in_review: "warning",
    scheduled: "warning",
    published: "positive",
    archived: "muted",
  };

export async function generateMetadata({
  params,
}: {
  params: Promise<{ type: string }>;
}): Promise<Metadata> {
  const { type } = await params;
  if (!isContentType(type)) return { title: "Content" };
  const row = await getContentType(type);
  return { title: row?.labelPlural ?? "Content" };
}

export default async function CollectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ type: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const { type } = await params;
  if (!isContentType(type)) notFound();

  const sp = await searchParams;
  const statuses = readEnumArray<ContentStatus>(sp, "status", CONTENT_STATUSES);
  const search = readString(sp, "q");
  const page = readInt(sp, "page", 1);

  const contentType = await getContentType(type);
  if (!contentType) notFound();

  const result = await listContent({
    type,
    status: statuses.length ? statuses : undefined,
    search,
    page,
    pageSize: 50,
    includeArchived: statuses.includes("archived"),
    sort: "updatedAt",
    direction: "desc",
  });

  const fields = editorFields(contentType.fields);

  const filterFields: FilterField[] = [
    { kind: "search", name: "q", placeholder: "Title, slug or summary" },
    {
      kind: "multi",
      name: "status",
      label: "Status",
      options: CONTENT_STATUSES.map((s) => ({ value: s, label: humanize(s) })),
    },
  ];

  const columns: Column<ContentListRow>[] = [
    {
      key: "title",
      header: "Item",
      sortable: true,
      cell: (row) => {
        const live = liveUrlFor(contentType, row);
        return (
          <div className="min-w-0">
            <Link
              href={`/admin/content/${type}/${row.id}`}
              className="font-medium text-zinc-900 underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-900"
            >
              {row.title}
            </Link>
            <div className="truncate text-[11px] text-zinc-500">
              /{row.slug}
              {live ? (
                <>
                  {" · "}
                  <a
                    href={live}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2 hover:text-zinc-900"
                  >
                    live page
                  </a>
                </>
              ) : null}
            </div>
          </div>
        );
      },
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
      key: "publishAt",
      header: "Scheduled",
      secondary: true,
      sortable: true,
      cell: (row) =>
        row.publishAt ? (
          <span className="text-zinc-600">{formatDateTime(row.publishAt)}</span>
        ) : (
          <span className="text-zinc-400">—</span>
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
    {
      key: "revisions",
      header: "Revisions",
      align: "right",
      secondary: true,
      cell: (row) => (
        <Link
          href={`/admin/content/${type}/${row.id}/history`}
          className="tabular text-zinc-600 underline underline-offset-2 hover:text-zinc-900"
        >
          v{row.revisionCount}
        </Link>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        breadcrumb={[{ label: "Content", href: "/admin/content" }]}
        title={contentType.labelPlural}
        description={contentType.description}
        actions={
          contentType.allowsCreate ? (
            <LinkButton href={`/admin/content/${type}/new`} variant="primary">
              New {contentType.label.toLowerCase()}
            </LinkButton>
          ) : (
            <Badge tone="muted">Maintained elsewhere</Badge>
          )
        }
      />

      <FilterBar
        pathname={`/admin/content/${type}`}
        params={sp}
        fields={filterFields}
      />

      <DataTable
        rows={result.rows}
        columns={columns}
        rowKey={(r) => r.id}
        caption={`${contentType.labelPlural} in the CMS`}
        pathname={`/admin/content/${type}`}
        params={sp}
        page={result.page}
        pageSize={result.pageSize}
        total={result.total}
        pageCount={result.pageCount}
        sort="updatedAt"
        direction="desc"
        emptyTitle={`No ${contentType.labelPlural.toLowerCase()} match`}
        emptyBody="Clear the filters, or create the first one."
        emptyAction={
          contentType.allowsCreate ? (
            <LinkButton href={`/admin/content/${type}/new`} variant="primary">
              New {contentType.label.toLowerCase()}
            </LinkButton>
          ) : undefined
        }
      />

      <Panel
        title="What this collection feeds, and the fields it has"
        description={`On the public site these become ${
          SITE_TARGETS[type]
        }${
          contentType.routePattern
            ? `, published at ${contentType.routePattern}`
            : ", which has no page of its own"
        }. The field list below is data — content_types.fields — so adding a field here is an UPDATE, not a deploy.`}
      >
        <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {fields.map((field) => (
            <li key={field.name} className="text-[12px]">
              <span className="font-medium text-zinc-900">{field.label}</span>
              <span className="text-zinc-400"> · </span>
              <code className="text-[11px] text-zinc-600">{field.name}</code>
              <span className="text-zinc-400"> · </span>
              <Badge tone="muted">{field.kind}</Badge>
              {field.required ? (
                <>
                  {" "}
                  <Badge tone="warning">required</Badge>
                </>
              ) : null}
              <p className="mt-0.5 text-[11px] text-zinc-500">
                {field.help ?? FIELD_KIND_NOTES[field.kind]}
              </p>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
