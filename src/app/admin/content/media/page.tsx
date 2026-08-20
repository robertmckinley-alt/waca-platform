import type { Metadata } from "next";

import { listAssets } from "@/db/queries";
import {
  Badge,
  EmptyState,
  FilterBar,
  PageHeader,
  Pagination,
  Panel,
  Tabs,
  type FilterField,
} from "@/components/ui";
import {
  AssetEditForm,
  AssetUploadForm,
} from "@/components/content/asset-forms";
import { formatBytes } from "@/lib/documents/labels";
import { formatDateTime } from "@/lib/format";
import {
  readBool,
  readInt,
  readString,
  type RawSearchParams,
} from "@/lib/search-params";
import { CONTENT_TABS } from "../shared";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Media library" };

/**
 * THE MEDIA LIBRARY.
 *
 * Every row here either describes its image or declares it decorative. That
 * is enforced by a CHECK on content_assets, by createAssetSchema, and by the
 * upload form refusing to submit — three layers, because an unlabelled image
 * on a public page is the single most common accessibility regression a CMS
 * introduces, and the one nobody notices until an audit.
 *
 * There are no thumbnails, and that is not an oversight: the bucket is
 * private and is not provisioned in this deployment, so a thumbnail would
 * either be a broken image or a fabrication. The library shows what it
 * actually knows — filename, type, dimensions, description, credit,
 * provenance — and says plainly which files have no bytes behind them yet.
 */
export default async function MediaPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const sp = await searchParams;
  const search = readString(sp, "q");
  const kind = readString(sp, "kind");
  const ai = readBool(sp, "ai");
  const includeArchived = readBool(sp, "archived") === true;
  const page = readInt(sp, "page", 1);

  const result = await listAssets({
    search,
    mimePrefix: kind ? `${kind}/` : undefined,
    aiGenerated: ai,
    includeArchived,
    page,
    pageSize: 24,
  });

  const missingAlt = result.rows.filter(
    (a) => a.mime.startsWith("image/") && !a.isDecorative && !a.altText?.trim(),
  ).length;

  const fields: FilterField[] = [
    { kind: "search", name: "q", placeholder: "Filename, alt text or credit" },
    {
      kind: "select",
      name: "kind",
      label: "Type",
      options: [
        { value: "image", label: "Images" },
        { value: "application", label: "Documents" },
        { value: "audio", label: "Audio" },
        { value: "video", label: "Video" },
      ],
    },
    {
      kind: "tristate",
      name: "ai",
      label: "Machine-generated",
      onLabel: "Yes",
      offLabel: "No",
    },
    {
      kind: "tristate",
      name: "archived",
      label: "Archived",
      onLabel: "Include",
      offLabel: "Exclude",
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        breadcrumb={[{ label: "Content", href: "/admin/content" }]}
        title="Media library"
        description="Images, documents and recordings the site's content points at. Alt text is a required field on images — see the note on the upload form for why, and for the one case where it is correct to leave it out."
      />

      <Tabs items={CONTENT_TABS} label="Content sections" />

      {missingAlt > 0 ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-800">
          {missingAlt} image{missingAlt === 1 ? "" : "s"} on this page{" "}
          {missingAlt === 1 ? "has" : "have"} no alt text and{" "}
          {missingAlt === 1 ? "is" : "are"} hidden from every picker in the
          editor until {missingAlt === 1 ? "it is" : "they are"} described.
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div>
          <AssetUploadForm />
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <FilterBar
            pathname="/admin/content/media"
            params={sp}
            fields={fields}
          />

          {result.rows.length === 0 ? (
            <EmptyState title="Nothing in the library matches">
              Clear the filters, or add the first file with the form beside
              this.
            </EmptyState>
          ) : (
            <ul className="flex flex-col gap-3">
              {result.rows.map((asset) => {
                const isImage = asset.mime.startsWith("image/");
                const undescribed =
                  isImage && !asset.isDecorative && !asset.altText?.trim();
                return (
                  <li key={asset.id}>
                    <Panel
                      title={asset.filename}
                      description={
                        <span className="flex flex-wrap items-center gap-2">
                          <span>{asset.mime}</span>
                          <span aria-hidden>·</span>
                          <span>{formatBytes(Number(asset.bytes))}</span>
                          {asset.width && asset.height ? (
                            <>
                              <span aria-hidden>·</span>
                              <span>
                                {asset.width}×{asset.height}
                              </span>
                            </>
                          ) : null}
                          <span aria-hidden>·</span>
                          <span>added {formatDateTime(asset.createdAt)}</span>
                        </span>
                      }
                      actions={
                        <span className="flex flex-wrap gap-1">
                          {undescribed ? (
                            <Badge tone="danger">No alt text</Badge>
                          ) : null}
                          {asset.isDecorative ? (
                            <Badge tone="muted">Decorative</Badge>
                          ) : null}
                          {asset.aiGenerated ? (
                            <Badge tone="warning">Machine-generated</Badge>
                          ) : null}
                          {asset.archivedAt ? (
                            <Badge tone="muted">Archived</Badge>
                          ) : null}
                        </span>
                      }
                    >
                      <dl className="grid gap-x-6 gap-y-2 text-[12px] sm:grid-cols-2">
                        <div>
                          <dt className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                            Alt text
                          </dt>
                          <dd className="mt-0.5 text-zinc-800">
                            {asset.isDecorative ? (
                              <span className="text-zinc-500">
                                Declared decorative — renders as alt=&quot;&quot;
                              </span>
                            ) : (
                              (asset.altText ?? (
                                <span className="text-red-600">
                                  Missing. This image cannot be used until it is
                                  described.
                                </span>
                              ))
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                            Credit
                          </dt>
                          <dd className="mt-0.5 text-zinc-800">
                            {asset.credit ?? "—"}
                          </dd>
                        </div>
                        <div className="sm:col-span-2">
                          <dt className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                            Storage key
                          </dt>
                          <dd className="mt-0.5 break-all font-mono text-[11px] text-zinc-600">
                            {asset.key}
                          </dd>
                        </div>
                        {asset.aiNote ? (
                          <div className="sm:col-span-2">
                            <dt className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                              Model and prompt
                            </dt>
                            <dd className="mt-0.5 text-zinc-700">
                              {asset.aiNote}
                            </dd>
                          </div>
                        ) : null}
                        {asset.longDescription ? (
                          <div className="sm:col-span-2">
                            <dt className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                              Long description
                            </dt>
                            <dd className="mt-0.5 text-zinc-700">
                              {asset.longDescription}
                            </dd>
                          </div>
                        ) : null}
                      </dl>

                      <details className="mt-3">
                        <summary className="cursor-pointer text-[12px] font-medium text-zinc-700 hover:text-zinc-900">
                          Edit, replace or archive
                        </summary>
                        <AssetEditForm
                          asset={{
                            id: asset.id,
                            key: asset.key,
                            filename: asset.filename,
                            mime: asset.mime,
                            altText: asset.altText,
                            isDecorative: asset.isDecorative,
                            credit: asset.credit,
                            aiGenerated: asset.aiGenerated,
                            aiNote: asset.aiNote,
                            longDescription: asset.longDescription,
                            archivedAt:
                              asset.archivedAt?.toISOString() ?? null,
                          }}
                        />
                      </details>
                    </Panel>
                  </li>
                );
              })}
            </ul>
          )}

          <Pagination
            pathname="/admin/content/media"
            params={sp}
            page={result.page}
            pageSize={result.pageSize}
            total={result.total}
            pageCount={result.pageCount}
          />
        </div>
      </div>
    </div>
  );
}
