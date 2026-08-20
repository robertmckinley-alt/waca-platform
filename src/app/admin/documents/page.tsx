import Link from "next/link";
import type { Metadata } from "next";

import {
  listDocumentsFor,
  listCouncils,
  STAFF_VIEWER,
  type DocumentSortKey,
} from "@/db/queries";
import {
  Badge,
  DataTable,
  FilterBar,
  LinkButton,
  PageHeader,
  StatTile,
  type Column,
  type FilterField,
} from "@/components/ui";
import {
  ACCESS_SCOPE_LABELS,
  DOCUMENT_CATEGORY_LABELS,
  DOCUMENT_CATEGORIES,
  formatBytes,
} from "@/lib/documents/labels";
import { formatDate } from "@/lib/format";
import { parseDocumentParams, ACCESS_SCOPES } from "./params";
import type { RawSearchParams } from "@/lib/search-params";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Documents" };

const SCOPE_TONE: Record<string, "neutral" | "positive" | "warning"> = {
  public: "positive",
  members: "neutral",
  "level-restricted": "warning",
  "council-restricted": "warning",
};

type Row = Awaited<ReturnType<typeof listDocumentsFor>>["rows"][number];

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const sp = await searchParams;
  const params = parseDocumentParams(sp);

  // Staff viewer: the single access predicate lets staff through, so the same
  // listDocumentsFor() the member library uses backs this page too. There is
  // no separate "admin document query" that could drift out of step with it.
  const [result, councils] = await Promise.all([
    listDocumentsFor(STAFF_VIEWER, {
      search: params.q,
      categories: params.categories,
      accessScopes: params.accessScopes,
      state: params.state,
      policyYear: params.policyYear,
      councilId: params.councilId,
      includeArchived: true,
      includeUnpublished: true,
      sort: params.sort as DocumentSortKey,
      direction: params.direction,
      page: params.page,
      pageSize: params.pageSize,
    }),
    listCouncils(),
  ]);

  const published = result.rows.filter((d) => d.publishedOn && !d.archivedAt);
  const drafts = result.rows.filter((d) => !d.publishedOn && !d.archivedAt);
  const restricted = result.rows.filter(
    (d) => d.accessScope !== "public" && d.accessScope !== "members",
  );

  const fields: FilterField[] = [
    { kind: "search", name: "q", placeholder: "Title or description" },
    {
      kind: "multi",
      name: "category",
      label: "Category",
      options: DOCUMENT_CATEGORIES.map((c) => ({
        value: c,
        label: DOCUMENT_CATEGORY_LABELS[c],
      })),
    },
    {
      kind: "multi",
      name: "scope",
      label: "Access",
      options: ACCESS_SCOPES.map((s) => ({
        value: s,
        label: ACCESS_SCOPE_LABELS[s] ?? s,
      })),
    },
    {
      kind: "select",
      name: "state",
      label: "State",
      options: [
        { value: "published", label: "Published" },
        { value: "draft", label: "Draft" },
        { value: "archived", label: "Archived" },
      ],
    },
    {
      kind: "select",
      name: "council",
      label: "Council",
      options: councils.map((c) => ({ value: c.id, label: c.name })),
    },
  ];

  const columns: Column<Row>[] = [
    {
      key: "title",
      header: "Document",
      sortable: true,
      defaultDirection: "asc",
      cell: (d) => (
        <div>
          <Link
            href={`/admin/documents/${d.id}`}
            className="font-medium text-zinc-900 hover:underline"
          >
            {d.title}
          </Link>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
            <span>{DOCUMENT_CATEGORY_LABELS[d.category] ?? d.category}</span>
            {d.archivedAt ? <Badge tone="neutral">Archived</Badge> : null}
            {!d.publishedOn && !d.archivedAt ? (
              <Badge tone="warning">Draft</Badge>
            ) : null}
            {d.isOcrNeeded ? <Badge tone="neutral">OCR needed</Badge> : null}
          </div>
        </div>
      ),
    },
    {
      key: "accessScope",
      header: "Access",
      cell: (d) => (
        <div>
          <Badge tone={SCOPE_TONE[d.accessScope] ?? "neutral"}>
            {ACCESS_SCOPE_LABELS[d.accessScope] ?? d.accessScope}
          </Badge>
          {d.accessScope === "level-restricted" &&
          d.levelRestrictions.length ? (
            <div className="mt-0.5 text-[11px] text-zinc-500">
              {d.levelRestrictions.length} level
              {d.levelRestrictions.length === 1 ? "" : "s"}
            </div>
          ) : null}
          {d.accessScope === "council-restricted" &&
          d.councilRestrictions.length ? (
            <div className="mt-0.5 text-[11px] text-zinc-500">
              {d.councilRestrictions.length} council
              {d.councilRestrictions.length === 1 ? "" : "s"}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: "publishedOn",
      header: "Published",
      sortable: true,
      cell: (d) => (
        <span className="tabular">
          {d.publishedOn ? formatDate(d.publishedOn) : "—"}
        </span>
      ),
    },
    {
      key: "policyYear",
      header: "Year",
      align: "right",
      secondary: true,
      cell: (d) => <span className="tabular">{d.policyYear ?? "—"}</span>,
    },
    {
      key: "bytes",
      header: "Size",
      align: "right",
      secondary: true,
      cell: (d) => <span className="tabular">{formatBytes(d.bytes)}</span>,
    },
    {
      key: "downloadCount",
      header: "Downloads",
      align: "right",
      sortable: true,
      cell: (d) => <span className="tabular">{d.downloadCount}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Documents"
        description="The member library. Access scope is set per document and enforced by one predicate shared with the member portal and the download route — a document is never hidden by the UI alone."
        actions={<LinkButton href="/admin/documents/new" variant="primary">Upload a document</LinkButton>}
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Documents (this page)" value={result.total} />
        <StatTile label="Published" value={published.length} />
        <StatTile
          label="Draft"
          value={drafts.length}
          sub={drafts.length ? "Not visible to members" : undefined}
        />
        <StatTile
          label="Level or council restricted"
          value={restricted.length}
        />
      </div>

      <FilterBar pathname="/admin/documents" params={sp} fields={fields} />

      <DataTable
        className="mt-3"
        rows={result.rows}
        columns={columns}
        rowKey={(d) => d.id}
        caption="Document library"
        pathname="/admin/documents"
        params={sp}
        page={result.page}
        pageSize={result.pageSize}
        total={result.total}
        pageCount={result.pageCount}
        sort={params.sort}
        direction={params.direction}
        emptyTitle="No documents match these filters"
        emptyBody="Clear a filter, or upload the first document in this category."
        emptyAction={<LinkButton href="/admin/documents/new">Upload a document</LinkButton>}
      />
    </>
  );
}
