"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Field, Input, Panel } from "@/components/ui";
import type { ContentIssue } from "@/lib/content/validate";
import type { PublishContentResult } from "@/lib/content/editor-types";
import { publishContent } from "@/app/admin/content/actions";

/**
 * ============================================================================
 *  THE PUBLISH QUEUE.
 *
 *  Everything whose newest revision is newer than the one that is live, with
 *  a per-item toggle, what changed in it, and one button that promotes the
 *  ticked set and rebuilds the site.
 *
 *  THE DEFAULTS ARE THE OPINION. An item that is already on the public site
 *  and has been edited starts ticked — somebody deliberately changed a live
 *  page and the point of this screen is to push it. An item that has NEVER
 *  been published starts unticked, because "publish" on a first draft is a
 *  decision, and a screen that pre-ticks it makes that decision by accident
 *  on somebody's behalf.
 *
 *  An item that would fail the site build cannot be ticked at all, and says
 *  why. The server checks this again — this checkbox is a courtesy, not a
 *  control.
 * ============================================================================
 */

export interface QueueRow {
  itemId: string;
  type: string;
  typeLabel: string;
  title: string;
  slug: string;
  status: string;
  isNew: boolean;
  /** "Headline, Body and 2 more" */
  diffText: string;
  changedLabels: string[];
  revisionNumber: number;
  publishedRevisionNumber: number | null;
  lastEditedBy: string | null;
  updatedAtLabel: string;
  editHref: string;
  historyHref: string;
  liveUrl: string | null;
  blockers: ContentIssue[];
  warnings: ContentIssue[];
  scheduledFor: string | null;
}

export function PublishQueue({
  rows,
  deployConfigured,
}: {
  rows: QueueRow[];
  deployConfigured: boolean;
}) {
  const router = useRouter();

  const publishable = useMemo(
    () => rows.filter((r) => r.blockers.length === 0),
    [rows],
  );

  const [selected, setSelected] = useState<Set<string>>(
    () =>
      new Set(
        publishable
          .filter((r) => !r.isNew && r.status !== "in_review")
          .map((r) => r.itemId),
      ),
  );
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PublishContentResult | null>(null);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function onPublish() {
    if (!selected.size) return;
    setBusy(true);
    setResult(null);
    const res = await publishContent({
      itemIds: [...selected],
      note: note.trim() || null,
    });
    setBusy(false);
    setResult(res);
    if (res.ok) {
      setSelected(new Set());
      router.refresh();
    }
  }

  const count = selected.size;
  const blockedCount = rows.length - publishable.length;

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Publish"
        description={
          deployConfigured
            ? "Publishing promotes the ticked revisions, then fires the Vercel deploy hook so the public site rebuilds from them."
            : "VERCEL_DEPLOY_HOOK_URL is not set in this deployment. Publishing will promote the revisions and record the run as “not deployed”; the site picks the changes up on its next build."
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              onClick={() =>
                setSelected(new Set(publishable.map((r) => r.itemId)))
              }
              disabled={!publishable.length}
            >
              Select all {publishable.length}
            </Button>
            <Button
              variant="secondary"
              onClick={() => setSelected(new Set())}
              disabled={!count}
            >
              Clear selection
            </Button>
            {blockedCount ? (
              <span className="text-[12px] text-red-700">
                {blockedCount} item{blockedCount === 1 ? "" : "s"} cannot be
                published — see the reasons below.
              </span>
            ) : null}
          </div>

          <Field
            label="Why (optional)"
            name="note"
            hint="Recorded against this publish run in the log, e.g. “2027 agenda goes live”."
          >
            <Input
              name="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={300}
            />
          </Field>

          <div>
            <Button
              variant="primary"
              size="md"
              disabled={busy || count === 0}
              onClick={() => void onPublish()}
            >
              {busy
                ? "Publishing…"
                : count === 0
                  ? "Nothing selected"
                  : `Publish ${count} item${count === 1 ? "" : "s"}${
                      deployConfigured ? " and rebuild the site" : ""
                    }`}
            </Button>
          </div>

          {result ? (
            <div
              role="status"
              className={
                result.ok
                  ? "rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-[12px] text-zinc-800"
                  : "rounded border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700"
              }
            >
              <p>{result.message}</p>
              {result.blocked?.length ? (
                <ul className="mt-1 list-disc pl-4">
                  {result.blocked.map((b) => (
                    <li key={b.itemId}>
                      {b.title}: {b.issues[0]?.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      </Panel>

      <ul className="flex flex-col gap-2">
        {rows.map((row) => {
          const blocked = row.blockers.length > 0;
          const id = `pub-${row.itemId}`;
          return (
            <li
              key={row.itemId}
              className={
                blocked
                  ? "rounded-md border border-red-200 bg-red-50/40 p-3"
                  : "rounded-md border border-zinc-200 bg-white p-3"
              }
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  id={id}
                  className="mt-1 size-3.5 accent-zinc-900"
                  checked={selected.has(row.itemId)}
                  disabled={blocked}
                  onChange={() => toggle(row.itemId)}
                  aria-describedby={`${id}-detail`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <label
                      htmlFor={id}
                      className="text-[13px] font-medium text-zinc-900"
                    >
                      {row.title}
                    </label>
                    <Badge tone="muted">{row.typeLabel}</Badge>
                    {row.isNew ? (
                      <Badge tone="warning">Never published</Badge>
                    ) : (
                      <Badge tone="neutral">
                        v{row.publishedRevisionNumber} → v{row.revisionNumber}
                      </Badge>
                    )}
                    {row.status === "in_review" ? (
                      <Badge tone="warning">In review</Badge>
                    ) : null}
                    {row.scheduledFor ? (
                      <Badge tone="warning">
                        Scheduled {row.scheduledFor}
                      </Badge>
                    ) : null}
                  </div>

                  <p
                    id={`${id}-detail`}
                    className="mt-1 text-[12px] text-zinc-600"
                  >
                    <span className="text-zinc-500">Changed: </span>
                    {row.diffText}
                    <span className="text-zinc-400"> · </span>
                    {row.updatedAtLabel}
                    {row.lastEditedBy ? ` by ${row.lastEditedBy}` : ""}
                  </p>

                  {blocked ? (
                    <ul className="mt-2 list-disc pl-4 text-[12px] text-red-700">
                      {row.blockers.map((b, i) => (
                        <li key={`${b.path}-${i}`}>{b.message}</li>
                      ))}
                    </ul>
                  ) : null}

                  {!blocked && row.warnings.length ? (
                    <ul className="mt-2 list-disc pl-4 text-[12px] text-amber-800">
                      {row.warnings.map((w, i) => (
                        <li key={`${w.path}-${i}`}>{w.message}</li>
                      ))}
                    </ul>
                  ) : null}

                  <p className="mt-2 flex flex-wrap gap-3 text-[12px]">
                    <Link
                      href={row.editHref}
                      className="text-zinc-600 underline underline-offset-2 hover:text-zinc-900"
                    >
                      Edit
                    </Link>
                    <Link
                      href={row.historyHref}
                      className="text-zinc-600 underline underline-offset-2 hover:text-zinc-900"
                    >
                      Full diff
                    </Link>
                    {row.liveUrl ? (
                      <a
                        href={row.liveUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-zinc-600 underline underline-offset-2 hover:text-zinc-900"
                      >
                        Live page
                      </a>
                    ) : null}
                  </p>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
