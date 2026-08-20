import Link from "next/link";
import type { Metadata } from "next";

import {
  getAssetsByKeys,
  listContent,
  listContentTypes,
  listPendingPublish,
  listPublishes,
} from "@/db/queries";
import {
  Badge,
  DataTable,
  EmptyState,
  PageHeader,
  Panel,
  Tabs,
  type Column,
} from "@/components/ui";
import {
  PublishQueue,
  type QueueRow,
} from "@/components/content/publish-queue";
import { RetryDeployButton } from "@/components/content/retry-deploy";
import { collectAssetKeys, editorFields } from "@/lib/content/fields";
import { diffRevisions, summariseDiff } from "@/lib/content/diff";
import { validateContent } from "@/lib/content/validate";
import { deployHookConfigured } from "@/lib/content/deploy-hook";
import { formatDateTime, humanize } from "@/lib/format";
import { CONTENT_TABS, liveUrlFor } from "../shared";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Publish" };

/**
 * THE PUBLISH QUEUE.
 *
 * Everything whose newest revision is newer than the one that is live, what
 * changed in each, whether it would survive the site's build, and one button.
 *
 * The validation gate runs here on the server against the revision that would
 * actually be promoted — the same Zod schemas mirrored from waca-web's
 * content.config.ts. An item that would fail `astro build` is listed with the
 * reason and cannot be ticked. The server action checks it again.
 */
export default async function PublishPage() {
  const [pending, types, publishes, scheduled] = await Promise.all([
    listPendingPublish(),
    listContentTypes(),
    listPublishes({ pageSize: 10 }),
    listContent({
      status: ["scheduled"],
      pageSize: 50,
      sort: "publishAt",
      direction: "asc",
    }),
  ]);

  const typeByKey = new Map(types.map((t) => [t.key, t]));
  const fieldsByType = new Map(types.map((t) => [t.key, editorFields(t.fields)]));

  // One asset lookup for the whole page rather than one per item.
  const allKeys = pending.flatMap((row) =>
    collectAssetKeys(
      fieldsByType.get(row.type) ?? [],
      row.latestRevision?.data ?? row.data,
    ),
  );
  const assetRows = await getAssetsByKeys(allKeys);
  const assets = Object.fromEntries(
    Object.entries(assetRows).map(([key, row]) => [
      key,
      {
        key: row.key,
        filename: row.filename,
        mime: row.mime,
        altText: row.altText,
        isDecorative: row.isDecorative,
      },
    ]),
  );

  const rows: QueueRow[] = pending.map((row) => {
    const contentType = typeByKey.get(row.type);
    const fields = fieldsByType.get(row.type) ?? [];
    const after = row.latestRevision ?? {
      title: row.title,
      slug: row.slug,
      excerpt: row.excerpt,
      data: row.data,
    };

    const diffs = diffRevisions(
      fields,
      row.publishedRevision
        ? {
            title: row.publishedRevision.title,
            slug: row.publishedRevision.slug,
            excerpt: row.publishedRevision.excerpt,
            data: row.publishedRevision.data,
          }
        : null,
      {
        title: after.title,
        slug: after.slug,
        excerpt: after.excerpt,
        data: after.data,
      },
    );
    const summary = summariseDiff(diffs);

    const report = validateContent({
      type: row.type,
      title: after.title,
      slug: after.slug,
      sortOrder: row.sortOrder,
      excerpt: after.excerpt,
      data: after.data,
      fields,
      assets,
    });

    return {
      itemId: row.id,
      type: row.type,
      typeLabel: contentType?.label ?? row.type,
      title: row.title,
      slug: row.slug,
      status: row.status,
      isNew: row.isNew,
      diffText: row.isNew ? "Everything — this is new" : summary.text,
      changedLabels: summary.labels,
      revisionNumber: row.latestRevision?.revisionNumber ?? 0,
      publishedRevisionNumber: row.publishedRevision?.revisionNumber ?? null,
      lastEditedBy: row.latestRevision?.authorLabel ?? null,
      updatedAtLabel: formatDateTime(row.updatedAt),
      editHref: `/admin/content/${row.type}/${row.id}`,
      historyHref: `/admin/content/${row.type}/${row.id}/history`,
      liveUrl: contentType
        ? liveUrlFor(contentType, {
            slug: row.publishedRevision?.slug ?? row.slug,
            data: row.data,
            status: row.publishedRevision ? "published" : row.status,
          })
        : null,
      blockers: report.errors,
      warnings: report.warnings,
      scheduledFor: row.publishAt ? formatDateTime(row.publishAt) : null,
    };
  });

  const configured = deployHookConfigured();

  const publishColumns: Column<(typeof publishes.rows)[number]>[] = [
    {
      key: "startedAt",
      header: "When",
      cell: (r) => (
        <span className="text-zinc-700">{formatDateTime(r.startedAt)}</span>
      ),
    },
    {
      key: "who",
      header: "By",
      cell: (r) => (
        <span className="text-zinc-700">{r.triggeredByLabel ?? "—"}</span>
      ),
    },
    {
      key: "items",
      header: "Items",
      align: "right",
      cell: (r) => <span className="tabular">{r.itemCount}</span>,
    },
    {
      key: "note",
      header: "Why",
      secondary: true,
      cell: (r) => (
        <span className="text-zinc-600">{r.note ?? "—"}</span>
      ),
    },
    {
      key: "status",
      header: "Deployment",
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge
            tone={
              r.status === "succeeded"
                ? "positive"
                : r.status === "failed"
                  ? "danger"
                  : "muted"
            }
          >
            {humanize(r.status)}
          </Badge>
          {r.deployHookStatus ? (
            <span className="tabular text-[11px] text-zinc-500">
              HTTP {r.deployHookStatus}
            </span>
          ) : (
            <span className="text-[11px] text-zinc-500">not deployed</span>
          )}
          {r.error ? (
            <span className="text-[11px] text-red-600">{r.error}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: "retry",
      header: "",
      align: "right",
      cell: (r) =>
        r.status === "failed" || r.deployHookStatus === null ? (
          <RetryDeployButton publishId={r.id} enabled={configured} />
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        breadcrumb={[{ label: "Content", href: "/admin/content" }]}
        title="Publish"
        description="Everything changed since the last publish. Publishing promotes the ticked revisions to live and rebuilds the public site from the new snapshot."
      />

      <Tabs items={CONTENT_TABS} label="Content sections" />

      {!configured ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-[13px] text-amber-900">
          <strong className="font-semibold">
            No deploy hook is configured in this deployment.
          </strong>{" "}
          Publishing still works — the revisions are promoted and{" "}
          <code className="font-mono text-[12px]">/api/content/*</code> serves
          them immediately — but the public site is not rebuilt, and each run is
          recorded as “not deployed”. Set{" "}
          <code className="font-mono text-[12px]">VERCEL_DEPLOY_HOOK_URL</code>{" "}
          to close the loop.
        </p>
      ) : null}

      {rows.length ? (
        <PublishQueue rows={rows} deployConfigured={configured} />
      ) : (
        <EmptyState title="Nothing is waiting to be published">
          Every item&rsquo;s newest revision is already the one on the public
          site.
        </EmptyState>
      )}

      <Panel
        title="Queued for a scheduled publish"
        description="These go live on their own when the scheduled sweep next runs. They also appear above, so you can push one early."
      >
        {scheduled.rows.length ? (
          <ul className="flex flex-col gap-1.5 text-[13px]">
            {scheduled.rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-2">
                <span className="tabular text-zinc-500">
                  {row.publishAt ? formatDateTime(row.publishAt) : "no date set"}
                </span>
                <Link
                  href={`/admin/content/${row.type}/${row.id}`}
                  className="font-medium text-zinc-900 underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-900"
                >
                  {row.title}
                </Link>
                <Badge tone="muted">
                  {typeByKey.get(row.type)?.label ?? row.type}
                </Badge>
                {!row.publishAt ? (
                  <Badge tone="danger">
                    Scheduled with no date — it will never go live
                  </Badge>
                ) : null}
                {row.unpublishAt ? (
                  <span className="text-[12px] text-zinc-500">
                    down again {formatDateTime(row.unpublishAt)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-zinc-600">
            Nothing is scheduled. Set a publish date on an item and mark it
            “Scheduled” to queue it.
          </p>
        )}
      </Panel>

      <Panel
        title="Publish log"
        description="Who pressed it, when, how many items went, and what the deploy hook said back. The hook URL is a credential and is never recorded."
        bodyClassName="p-0"
      >
        <DataTable
          rows={publishes.rows}
          columns={publishColumns}
          rowKey={(r) => r.id}
          caption="Recent publish runs"
          emptyTitle="Nothing has been published yet"
          emptyBody="The first publish from this CMS will appear here."
        />
      </Panel>
    </div>
  );
}
