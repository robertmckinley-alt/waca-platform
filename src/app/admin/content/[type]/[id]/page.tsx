import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { getContentItem } from "@/db/queries";
import { Badge, PageHeader } from "@/components/ui";
import { ContentEditor, type EditorItem } from "@/components/content/editor";
import { ArchiveToggle } from "@/components/content/archive-toggle";
import { emptyValue } from "@/lib/content/fields";
import {
  mintPreviewToken,
  PREVIEW_TOKEN_TTL_SECONDS,
} from "@/lib/content/preview-token";
import { formatDateTime } from "@/lib/format";
import { isContentType, liveUrlFor, loadEditorContext } from "../../shared";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ type: string; id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const detail = await getContentItem(id);
  return { title: detail?.item.title ?? "Content" };
}

export default async function ContentEditorPage({
  params,
}: {
  params: Promise<{ type: string; id: string }>;
}) {
  const { type, id } = await params;
  if (!isContentType(type)) notFound();

  const detail = await getContentItem(id);
  if (!detail || detail.item.type !== type) notFound();

  const ctx = await loadEditorContext(type, detail.item.id);

  // Fill in any field the collection has gained since this item was last
  // saved, so a new field renders empty rather than as `undefined`.
  const data: Record<string, unknown> = { ...detail.item.data };
  for (const field of ctx.fields) {
    if (!(field.name in data)) data[field.name] = emptyValue(field);
  }

  const item: EditorItem = {
    id: detail.item.id,
    type,
    slug: detail.item.slug,
    title: detail.item.title,
    excerpt: detail.item.excerpt ?? "",
    status: detail.item.status,
    locale: detail.item.locale,
    sortOrder: detail.item.sortOrder,
    publishAt: detail.item.publishAt?.toISOString() ?? "",
    unpublishAt: detail.item.unpublishAt?.toISOString() ?? "",
    data,
    revisionNumber: detail.latestRevision?.revisionNumber ?? 0,
    publishedRevisionNumber: detail.publishedRevision?.revisionNumber ?? null,
    publishedSlug: detail.publishedRevision?.slug ?? null,
  };

  /**
   * "What the site will look like." For a published item that is the real
   * page. For a draft it is the JSON payload the Astro build would receive,
   * behind a five-minute signed token — the public site is static and cannot
   * render an unbuilt draft, and a link that pretended otherwise would be a
   * lie. docs/SITE-INTEGRATION.md carries the loader that turns this into a
   * rendered preview route on the site when WACA wants one.
   */
  const previewUrl = `/api/content/preview?item=${detail.item.id}&token=${mintPreviewToken(
    detail.item.id,
    PREVIEW_TOKEN_TTL_SECONDS,
  )}`;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        breadcrumb={[
          { label: "Content", href: "/admin/content" },
          {
            label: ctx.contentType.labelPlural,
            href: `/admin/content/${type}`,
          },
        ]}
        title={detail.item.title}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              {detail.publishedRevision
                ? `Live as revision ${detail.publishedRevision.revisionNumber}, published ${formatDateTime(
                    detail.item.publishedAt,
                  )}.`
                : "Never published."}
            </span>
            <Link
              href={`/admin/content/${type}/${detail.item.id}/history`}
              className="underline underline-offset-2 hover:text-zinc-900"
            >
              {detail.revisionCount} revision
              {detail.revisionCount === 1 ? "" : "s"}
            </Link>
            {detail.item.status === "archived" ? (
              <Badge tone="muted">Archived</Badge>
            ) : null}
          </span>
        }
        actions={
          <ArchiveToggle
            itemId={detail.item.id}
            archived={detail.item.status === "archived"}
          />
        }
      />

      <ContentEditor
        item={item}
        fields={ctx.fields}
        typeLabel={ctx.contentType.label}
        fieldsHelp={ctx.contentType.description}
        rules={ctx.rules}
        assets={ctx.assets}
        references={ctx.references}
        takenSlugs={ctx.takenSlugs}
        liveUrl={liveUrlFor(ctx.contentType, {
          slug: detail.publishedRevision?.slug ?? detail.item.slug,
          data: detail.item.data,
          status: detail.item.status,
        })}
        previewUrl={previewUrl}
        collectionHref={`/admin/content/${type}`}
      />
    </div>
  );
}
