"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import {
  Badge,
  Button,
  Field,
  Input,
  Panel,
  Select,
  Textarea,
} from "@/components/ui";
import type { ContentStatus, ContentTypeKey } from "@/db/queries";
import { type EditorField, isBlank, SLUG_PATTERN, slugify } from "@/lib/content/fields";
import { validateContent } from "@/lib/content/validate";
import type { ContentIssue } from "@/lib/content/validate";
import type { EditorialRule } from "@/lib/content/rules";
import { TITLE_KEY } from "@/lib/content/site-schemas";
import type { SaveContentResult } from "@/lib/content/editor-types";
import { publishContent, saveContent } from "@/app/admin/content/actions";
import { FieldControl, type AssetChoice, type ReferenceChoice } from "./field-control";

/**
 * ============================================================================
 *  THE EDITOR.
 *
 *  Rendered entirely from content_types.fields. There is no per-collection
 *  component and there must not be one — the day somebody writes PressEditor
 *  is the day adding a field stops being a data change.
 *
 *  AUTOSAVE. Debounced, 1.5 seconds after the last keystroke, with a state
 *  that is always on screen: unsaved / saving / saved / failed. Every autosave
 *  writes a real revision and a real audit row; it is not a lesser kind of
 *  save. Two deliberate limits:
 *
 *   · A brand-new item does not autosave until it has a title and a valid
 *     slug. Autosaving a blank form would put an empty row in the collection
 *     every time somebody clicked "New" and changed their mind.
 *   · The first save of a new item rewrites the URL with history.replaceState
 *     rather than navigating. A router push would unmount the form the
 *     staffer is typing into, which is a strange way to protect their work.
 *
 *  SAVING NEVER PUBLISHES. The status control offers draft, in review,
 *  scheduled and archived. "Published" is not in it, because the only thing
 *  that changes the public site is the Publish button, and it is a different
 *  button in a different place with a different colour.
 *
 *  VALIDATION runs here on every keystroke against the SAME Zod schemas
 *  mirrored from waca-web/src/content.config.ts. A field that would fail
 *  `astro build` is red before it can ever reach a deploy log.
 * ============================================================================
 */

export interface EditorItem {
  id: string | null;
  type: ContentTypeKey;
  slug: string;
  title: string;
  excerpt: string;
  status: ContentStatus;
  locale: string;
  sortOrder: number;
  /** ISO strings, or "" for unset. */
  publishAt: string;
  unpublishAt: string;
  data: Record<string, unknown>;
  revisionNumber: number;
  publishedRevisionNumber: number | null;
  /** The slug that is live right now. Null until first publish. */
  publishedSlug: string | null;
}

export interface ContentEditorProps {
  item: EditorItem;
  fields: EditorField[];
  typeLabel: string;
  fieldsHelp: string | null;
  rules: EditorialRule[];
  assets: AssetChoice[];
  references: Record<string, ReferenceChoice[]>;
  /** Slugs already used in this collection, excluding this item's own. */
  takenSlugs: string[];
  /** Where this item lives on the public site once published. */
  liveUrl: string | null;
  /** Signed, short-lived draft preview. */
  previewUrl: string | null;
  collectionHref: string;
}

type SaveState = "clean" | "unsaved" | "saving" | "saved" | "failed";

const AUTOSAVE_MS = 1500;

const STATUS_OPTIONS: { value: Exclude<ContentStatus, "published">; label: string }[] =
  [
    { value: "draft", label: "Draft" },
    { value: "in_review", label: "In review" },
    { value: "scheduled", label: "Scheduled" },
    { value: "archived", label: "Archived" },
  ];

export function ContentEditor({
  item,
  fields,
  typeLabel,
  fieldsHelp,
  rules,
  assets,
  references,
  takenSlugs,
  liveUrl,
  previewUrl,
  collectionHref,
}: ContentEditorProps) {
  const router = useRouter();

  const [draft, setDraft] = useState<EditorItem>(item);
  const [itemId, setItemId] = useState<string | null>(item.id);
  const [saveState, setSaveState] = useState<SaveState>("clean");
  const [message, setMessage] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string[]>>({});
  const [revision, setRevision] = useState(item.revisionNumber);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishNote, setPublishNote] = useState<string | null>(null);
  const [slugTouched, setSlugTouched] = useState(Boolean(item.slug));

  const inFlight = useRef(false);
  const pending = useRef(false);
  /**
   * The newest draft, readable from inside an in-flight save.
   *
   * Without this, typing WHILE a save is in the air ends badly: patch() sets
   * the state to "unsaved", the response lands and sets it to "saved", the
   * debounce effect sees "saved" and never fires, and the last few keystrokes
   * sit in the browser unsaved under a green tick. Comparing what was sent
   * with what is on screen when the response lands is how "saved" stays a
   * true statement.
   */
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const main = fields.filter((f) => !f.sidebar);
  const side = fields.filter((f) => f.sidebar);

  /* ------------------------------------------------------ validation */

  const assetIndex = useMemo(
    () =>
      Object.fromEntries(
        assets.map((a) => [
          a.key,
          {
            key: a.key,
            filename: a.filename,
            mime: a.mime,
            altText: a.altText,
            isDecorative: a.isDecorative,
          },
        ]),
      ),
    [assets],
  );

  const report = useMemo(
    () =>
      validateContent({
        type: draft.type,
        title: draft.title,
        slug: draft.slug,
        sortOrder: draft.sortOrder,
        excerpt: draft.excerpt,
        data: draft.data,
        fields,
        assets: assetIndex,
      }),
    [draft, fields, assetIndex],
  );

  const slugIssues: ContentIssue[] = useMemo(() => {
    const out: ContentIssue[] = [];
    if (isBlank(draft.slug)) {
      out.push({
        path: "slug",
        field: "slug",
        label: "Slug",
        message: "Give this a slug — it is the last part of its URL.",
      });
    } else if (!SLUG_PATTERN.test(draft.slug)) {
      out.push({
        path: "slug",
        field: "slug",
        label: "Slug",
        message:
          "Lower-case words separated by single hyphens: waca-opposes-hb-2022.",
      });
    } else if (takenSlugs.includes(draft.slug)) {
      out.push({
        path: "slug",
        field: "slug",
        label: "Slug",
        message:
          "Another item in this collection already uses that slug. Slugs are URLs, so they have to be unique.",
      });
    }
    return out;
  }, [draft.slug, takenSlugs]);

  const slugChanged =
    Boolean(draft.publishedSlug) && draft.slug !== draft.publishedSlug;

  const allErrors = [...slugIssues, ...report.errors];

  /* ----------------------------------------------------------- saving */

  /**
   * The item id, in a ref as well as in state.
   *
   * The queued-retry path below re-enters the SAME closure, which captured
   * `itemId` from the render it was built in. On the first save of a new item
   * that value is null — so the retry would post a second CREATE with the
   * slug the first one just took, and the staffer would watch their new press
   * release fail with "that slug is already taken" by their own first save.
   */
  const itemIdRef = useRef(itemId);
  itemIdRef.current = itemId;

  const doSave = useCallback(
    async (opts: { autosave: boolean }): Promise<SaveContentResult | null> => {
      if (inFlight.current) {
        // A save is already in the air. Mark that another is wanted and let
        // the in-flight one start it when it lands, rather than racing it.
        pending.current = true;
        return null;
      }
      inFlight.current = true;
      setSaveState("saving");

      // Read from the refs, not from the closure: this function is re-entered
      // by the retry below and must always send what is on screen NOW.
      const current = draftRef.current;
      const sent = serialise(current);

      const result = await saveContent({
        itemId: itemIdRef.current,
        type: current.type,
        slug: current.slug,
        title: current.title,
        excerpt: current.excerpt || null,
        data: current.data,
        status:
          current.status === "published"
            ? undefined
            : (current.status as Exclude<ContentStatus, "published">),
        publishAt: current.publishAt || null,
        unpublishAt: current.unpublishAt || null,
        sortOrder: current.sortOrder,
        locale: current.locale,
        autosave: opts.autosave,
      });

      inFlight.current = false;

      if (result.ok) {
        const movedOn = serialise(draftRef.current) !== sent;
        setServerErrors({});
        setRevision(result.revisionNumber ?? 0);
        setSavedAt(result.savedAt ?? new Date().toISOString());
        // Only claim "saved" if what is on screen is what went to the server.
        setSaveState(movedOn ? "unsaved" : "saved");
        setMessage(null);
        if (!itemIdRef.current && result.itemId) {
          // The ref FIRST, so the queued retry below already knows.
          itemIdRef.current = result.itemId;
          setItemId(result.itemId);
          // Rewrite the address bar without unmounting this form.
          window.history.replaceState(
            null,
            "",
            `${collectionHref}/${result.itemId}`,
          );
        }
      } else {
        setSaveState("failed");
        setMessage(result.message ?? "The save did not go through.");
        setServerErrors(result.fieldErrors ?? {});
      }

      if (pending.current) {
        pending.current = false;
        void doSave({ autosave: true });
      }
      return result;
    },
    [collectionHref],
  );

  /* Debounce. Only fires when there is something worth saving. */
  const canAutosave =
    Boolean(itemId) ||
    (draft.title.trim().length > 0 && SLUG_PATTERN.test(draft.slug));

  useEffect(() => {
    if (saveState !== "unsaved") return;
    if (!canAutosave) return;
    const timer = setTimeout(() => {
      void doSave({ autosave: true });
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
    // doSave is rebuilt on every draft change; depending on it would restart
    // the timer on every keystroke, which is what the debounce is for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveState, canAutosave, draft]);

  /* Nobody loses work to a closed tab. */
  useEffect(() => {
    if (saveState !== "unsaved" && saveState !== "failed") return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [saveState]);

  const patch = useCallback((next: Partial<EditorItem>) => {
    setDraft((prev) => ({ ...prev, ...next }));
    setSaveState("unsaved");
  }, []);

  const setDataField = useCallback(
    (name: string, value: unknown) => {
      setDraft((prev) => {
        const data = { ...prev.data, [name]: value };
        // The item's title column follows the collection's own headline field
        // so the list, the history and the site never disagree about what a
        // thing is called.
        const titleKey = TITLE_KEY[prev.type];
        const title =
          titleKey === name && typeof value === "string" && value.trim()
            ? value
            : prev.title;
        return { ...prev, data, title };
      });
      setSaveState("unsaved");
    },
    [],
  );

  /* --------------------------------------------------------- publish */

  async function onPublish() {
    if (!itemId) return;
    setPublishing(true);
    setPublishNote(null);
    // Flush any pending edit first: publishing promotes the newest revision,
    // and an unsaved paragraph would silently not be in it.
    if (saveState === "unsaved" || saveState === "failed") {
      const saved = await doSave({ autosave: false });
      if (saved && !saved.ok) {
        setPublishing(false);
        setPublishNote("Could not save before publishing, so nothing was published.");
        return;
      }
    }
    const result = await publishContent({ itemIds: [itemId] });
    setPublishing(false);
    setPublishNote(result.message);
    if (result.ok) router.refresh();
  }

  /* ------------------------------------------------------------ view */

  const titleKey = TITLE_KEY[draft.type];
  const hasUnpublished =
    draft.publishedRevisionNumber === null ||
    revision > draft.publishedRevisionNumber;

  return (
    <div className="flex flex-col gap-4">
      <SaveBar
        state={saveState}
        savedAt={savedAt}
        revision={revision}
        message={message}
        onSave={() => void doSave({ autosave: false })}
        canAutosave={canAutosave}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* --------------------------------------------------- main */}
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title={`${typeLabel} — identity`}>
            <div className="flex flex-col gap-3">
              {!titleKey ? (
                <Field
                  label="Title"
                  name="title"
                  required
                  errors={serverErrors.title}
                >
                  <Input
                    name="title"
                    value={draft.title}
                    onChange={(e) => {
                      patch({ title: e.target.value });
                      if (!slugTouched && !draft.publishedSlug) {
                        patch({ slug: slugify(e.target.value) });
                      }
                    }}
                  />
                </Field>
              ) : null}

              <Field
                label="Slug"
                name="slug"
                required
                errors={[
                  ...slugIssues.map((i) => i.message),
                  ...(serverErrors.slug ?? []),
                ]}
                hint="The last part of the URL. Lower-case words, single hyphens."
              >
                <Input
                  name="slug"
                  value={draft.slug}
                  onChange={(e) => {
                    setSlugTouched(true);
                    patch({ slug: e.target.value });
                  }}
                />
              </Field>

              {slugChanged ? (
                <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
                  <strong className="font-semibold">
                    This page is live at /{draft.publishedSlug}.
                  </strong>{" "}
                  Publishing this change moves it to /{draft.slug} and every
                  existing link, share and citation to the old address stops
                  working. Change it only if the old one was wrong, and tell
                  whoever maintains the redirects.
                </p>
              ) : null}

              <Field
                label="Summary"
                name="excerpt"
                hint="One or two sentences. This is the card and the search result, not the body."
              >
                <Textarea
                  name="excerpt"
                  rows={2}
                  value={draft.excerpt}
                  onChange={(e) => patch({ excerpt: e.target.value })}
                />
              </Field>
            </div>
          </Panel>

          <Panel
            title="Content"
            description={fieldsHelp ?? undefined}
          >
            <div className="flex flex-col gap-5">
              {main.map((field) => (
                <FieldControl
                  key={field.name}
                  field={field}
                  path={field.name}
                  value={draft.data[field.name]}
                  onChange={(v) => setDataField(field.name, v)}
                  assets={assets}
                  references={references}
                  issues={report.errors}
                />
              ))}
              {main.length === 0 ? (
                <p className="text-[13px] text-zinc-500">
                  This collection defines no main-column fields.
                </p>
              ) : null}
            </div>
          </Panel>
        </div>

        {/* ------------------------------------------------- sidebar */}
        <div className="flex flex-col gap-4">
          <Panel title="Status and schedule">
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Badge tone={draft.status === "published" ? "positive" : "muted"}>
                  {draft.status === "in_review" ? "In review" : draft.status}
                </Badge>
                {hasUnpublished ? (
                  <Badge tone="warning">Unpublished changes</Badge>
                ) : null}
              </div>

              {/*
                A live page keeps "Published (live)" as its selected value.
                Collapsing it to "Draft" would show a live page as a draft,
                and — worse — a staffer who touched the control to see what
                was in it would take the page off the site without ever
                choosing to. Moving a live page to any other status is still
                possible; it just has to be a decision, and it says what it
                does underneath.
              */}
              <Field
                label="Status"
                name="status"
                hint={
                  draft.status === "published"
                    ? "This page is live. Saving never changes that — use Publish to push edits, or Archive to take it down."
                    : "Saving never publishes. Use the Publish button."
                }
              >
                <Select
                  name="status"
                  value={draft.status}
                  onChange={(e) =>
                    patch({ status: e.target.value as ContentStatus })
                  }
                >
                  {draft.status === "published" ? (
                    <option value="published">Published (live)</option>
                  ) : null}
                  {STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </Field>

              {item.status === "published" && draft.status !== "published" ? (
                <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
                  This page is on the public site now. Saving it as{" "}
                  <strong className="font-semibold">
                    {draft.status === "in_review" ? "in review" : draft.status}
                  </strong>{" "}
                  removes it from the published snapshot, so the next site
                  build will drop the page. Use Archive instead if that is what
                  you meant.
                </p>
              ) : null}

              <Field
                label="Publish at"
                name="publishAt"
                hint={
                  draft.status === "scheduled"
                    ? "The scheduled sweep publishes this and rebuilds the site."
                    : "Set a date and choose “Scheduled” to queue it."
                }
              >
                <Input
                  name="publishAt"
                  type="datetime-local"
                  value={toLocalInput(draft.publishAt)}
                  onChange={(e) =>
                    patch({ publishAt: fromLocalInput(e.target.value) })
                  }
                />
              </Field>

              <Field
                label="Take down at"
                name="unpublishAt"
                hint="Optional. Leave empty for anything that should stay up."
              >
                <Input
                  name="unpublishAt"
                  type="datetime-local"
                  value={toLocalInput(draft.unpublishAt)}
                  onChange={(e) =>
                    patch({ unpublishAt: fromLocalInput(e.target.value) })
                  }
                />
              </Field>

              <Field
                label="Order"
                name="sortOrder"
                hint="Lower numbers come first in lists on the site."
              >
                <Input
                  name="sortOrder"
                  type="number"
                  min={0}
                  value={String(draft.sortOrder)}
                  onChange={(e) =>
                    patch({ sortOrder: Number(e.target.value) || 0 })
                  }
                />
              </Field>
            </div>
          </Panel>

          {side.length ? (
            <Panel title="Details">
              <div className="flex flex-col gap-4">
                {side.map((field) => (
                  <FieldControl
                    key={field.name}
                    field={field}
                    path={field.name}
                    value={draft.data[field.name]}
                    onChange={(v) => setDataField(field.name, v)}
                    assets={assets}
                    references={references}
                    issues={report.errors}
                  />
                ))}
              </div>
            </Panel>
          ) : null}

          <Panel title="Publishing">
            <div className="flex flex-col gap-2">
              {allErrors.length ? (
                <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
                  <p className="font-medium">
                    {allErrors.length} thing
                    {allErrors.length === 1 ? "" : "s"} would fail the site
                    build:
                  </p>
                  <ul className="mt-1 list-disc pl-4">
                    {allErrors.slice(0, 6).map((issue, i) => (
                      <li key={`${issue.path}-${i}`}>{issue.message}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-[12px] text-zinc-600">
                  Everything the public site&rsquo;s build requires is present.
                </p>
              )}

              {report.warnings.length ? (
                <ul className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
                  {report.warnings.map((w, i) => (
                    <li key={`${w.path}-${i}`}>{w.message}</li>
                  ))}
                </ul>
              ) : null}

              <Button
                variant="primary"
                disabled={
                  !itemId || publishing || allErrors.length > 0 || !hasUnpublished
                }
                onClick={() => void onPublish()}
              >
                {publishing
                  ? "Publishing…"
                  : hasUnpublished
                    ? "Publish and rebuild the site"
                    : "Nothing to publish"}
              </Button>

              {publishNote ? (
                <p role="status" className="text-[12px] text-zinc-700">
                  {publishNote}
                </p>
              ) : null}

              <div className="flex flex-col gap-1 border-t border-zinc-200 pt-2 text-[12px]">
                {liveUrl ? (
                  <a
                    href={liveUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-zinc-600 underline underline-offset-2 hover:text-zinc-900"
                  >
                    See the live page on the site →
                  </a>
                ) : null}
                {previewUrl ? (
                  <a
                    href={previewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-zinc-600 underline underline-offset-2 hover:text-zinc-900"
                  >
                    Preview the draft the site would receive →
                  </a>
                ) : null}
                {itemId ? (
                  <Link
                    href={`${collectionHref}/${itemId}/history`}
                    className="text-zinc-600 underline underline-offset-2 hover:text-zinc-900"
                  >
                    Revision history (v{revision}) →
                  </Link>
                ) : null}
              </div>
            </div>
          </Panel>

          <Panel
            title="The rules this collection lives by"
            description="Everything marked “build rule” is enforced by the public site's build. It is stated here so you find out now, not from a deploy log."
          >
            <ul className="flex flex-col gap-3">
              {rules.map((rule) => (
                <li key={rule.id}>
                  <p className="flex items-start gap-1.5 text-[12px] font-medium text-zinc-900">
                    <Badge tone={rule.severity === "hard" ? "warning" : "muted"}>
                      {rule.severity === "hard" ? "Build rule" : "House style"}
                    </Badge>
                    <span>{rule.title}</span>
                  </p>
                  <p className="mt-1 text-[12px] leading-5 text-zinc-600">
                    {rule.body}
                  </p>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ save bar */

function SaveBar({
  state,
  savedAt,
  revision,
  message,
  onSave,
  canAutosave,
}: {
  state: SaveState;
  savedAt: string | null;
  revision: number;
  message: string | null;
  onSave: () => void;
  canAutosave: boolean;
}) {
  const label: Record<SaveState, string> = {
    clean: "No changes",
    unsaved: canAutosave ? "Unsaved changes" : "Not saved yet",
    saving: "Saving…",
    saved: savedAt
      ? `Saved ${new Date(savedAt).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        })} as revision ${revision}`
      : "Saved",
    failed: "Save failed",
  };

  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-white/95 py-2 backdrop-blur">
      <span
        role="status"
        aria-live="polite"
        className={cn(
          "inline-flex items-center gap-1.5 text-[12px]",
          state === "failed" && "text-red-600",
          state === "saved" && "text-zinc-600",
          state === "unsaved" && "text-amber-700",
          state === "saving" && "text-zinc-500",
          state === "clean" && "text-zinc-500",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "inline-block size-1.5 rounded-full",
            state === "failed" && "bg-red-500",
            state === "saved" && "bg-zinc-400",
            state === "unsaved" && "bg-amber-500",
            state === "saving" && "bg-zinc-300",
            state === "clean" && "bg-zinc-200",
          )}
        />
        {label[state]}
      </span>

      {!canAutosave && state === "unsaved" ? (
        <span className="text-[12px] text-zinc-500">
          Autosave starts once this has a title and a valid slug.
        </span>
      ) : null}

      <Button
        variant="secondary"
        onClick={onSave}
        disabled={state === "saving"}
      >
        Save now
      </Button>

      {message ? (
        <span className="text-[12px] text-red-600">{message}</span>
      ) : null}
    </div>
  );
}

/**
 * Everything about a draft that a save would send. Used only to answer "has
 * this changed since I posted it?", so it has to cover every editable field
 * and nothing else.
 */
function serialise(draft: EditorItem): string {
  return JSON.stringify([
    draft.slug,
    draft.title,
    draft.excerpt,
    draft.status,
    draft.locale,
    draft.sortOrder,
    draft.publishAt,
    draft.unpublishAt,
    draft.data,
  ]);
}

/* -------------------------------------------------------------- dates */

function toLocalInput(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}
