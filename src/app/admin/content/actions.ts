"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { contentAssets, contentItems } from "@/db/schema";
import {
  createAsset,
  getAssetsByKeys,
  getContentItem,
  getContentType,
  listContentTypes,
  publishItems,
  recordPublishDispatch,
  restoreRevision,
  saveDraft,
  type ContentTypeKey,
} from "@/db/queries";
import { requireStaff } from "@/lib/admin-auth";
import { recordAudit } from "@/lib/audit";
import {
  checkboxSchema,
  fail,
  formToObject,
  invalid,
  ok,
  type ActionState,
} from "@/lib/action-state";
import { putDocumentObject, storageIsConfigured } from "@/lib/documents/storage";
import { collectAssetKeys, editorFields, SLUG_PATTERN } from "@/lib/content/fields";
import { validateContent, type ContentIssue } from "@/lib/content/validate";
import { deployHookConfigured, fireDeployHook } from "@/lib/content/deploy-hook";
import type {
  PublishContentInput,
  PublishContentResult,
  SaveContentInput,
  SaveContentResult,
} from "@/lib/content/editor-types";

/**
 * ==========================================================================
 *  CMS — staff actions.
 *
 *  Every write here is: requireStaff() -> Zod -> one transaction that
 *  contains both the write and its audit_log row -> revalidatePath. That is
 *  the same shape as every other mutation in this codebase and there is no
 *  reason for the CMS to be the exception.
 *
 *  Two things are specific to this module and worth stating plainly:
 *
 *  SAVING IS NOT PUBLISHING. saveContent() cannot set status to 'published'
 *  — the type will not let it and neither will saveDraft()'s own schema. The
 *  only thing that changes what is on the public site is publishContent().
 *
 *  AUTOSAVE IS A REAL SAVE. It writes a real revision and a real audit row,
 *  stamped `autosave: true`. It was tempting to skip the audit row to keep
 *  the trail readable, and that would have been the one write in the
 *  application whose actor is unknown. Filter the trail instead.
 * ==========================================================================
 */

const CONTENT_TYPES = [
  "page",
  "press",
  "record",
  "agenda",
  "post",
  "person",
  "member",
  "stat",
  "nav",
  "setting",
] as const satisfies readonly ContentTypeKey[];

/* ---------------------------------------------------------------- save */

const isoNullable = z
  .string()
  .trim()
  .min(1)
  .nullish()
  .transform((v) => (v ? new Date(v) : null))
  .refine((d) => d === null || !Number.isNaN(d.getTime()), {
    message: "That is not a date this application can read.",
  });

const saveSchema = z.object({
  itemId: z.uuid().nullish(),
  type: z.enum(CONTENT_TYPES),
  slug: z
    .string()
    .trim()
    .min(1, "Give this a slug — it is the last part of its URL.")
    .max(160)
    .regex(
      SLUG_PATTERN,
      "A slug is lower-case words separated by single hyphens: waca-opposes-hb-2022.",
    ),
  title: z.string().trim().min(1, "Give this a title.").max(300),
  excerpt: z.string().trim().max(600).nullish(),
  data: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(["draft", "in_review", "scheduled", "archived"]).optional(),
  publishAt: isoNullable,
  unpublishAt: isoNullable,
  sortOrder: z.coerce.number().int().min(0).max(100000).default(0),
  locale: z.string().trim().min(2).max(12).default("en-US"),
  summary: z.string().trim().max(300).nullish(),
  autosave: z.boolean().default(false),
});

/**
 * Create or update a draft. Called by the Save button AND by the debounce.
 *
 * Returns a result object rather than throwing, because the editor renders it
 * inline next to a "saved / saving / unsaved" indicator — an autosave that
 * failed has to say so quietly and keep the staffer's text, not blow up the
 * page they are typing into.
 */
export async function saveContent(
  input: SaveContentInput,
): Promise<SaveContentResult> {
  const actor = await requireStaff();

  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) {
    const flat = z.flattenError(parsed.error);
    return {
      ok: false,
      message: "Fix the highlighted fields and try again.",
      fieldErrors: flat.fieldErrors as Record<string, string[]>,
    };
  }
  const value = parsed.data;

  const contentType = await getContentType(value.type);
  if (!contentType) {
    return { ok: false, message: `There is no “${value.type}” collection.` };
  }
  if (!value.itemId && !contentType.allowsCreate) {
    return {
      ok: false,
      message:
        `${contentType.labelPlural} are not created here. ` +
        (value.type === "member"
          ? "A member listing is derived from the membership tables by the directory sync."
          : "This collection is maintained elsewhere."),
    };
  }

  // Slug uniqueness, checked before the insert so the staffer gets a sentence
  // instead of a Postgres constraint name. The unique index is still the
  // guarantee — this is only the message.
  const clash = await getContentItem(value.slug, {
    type: value.type,
    locale: value.locale,
  });
  if (clash && clash.item.id !== value.itemId) {
    return {
      ok: false,
      message: "That slug is already taken in this collection.",
      fieldErrors: {
        slug: [
          `“${value.slug}” is already used by “${clash.item.title}”. Slugs have ` +
            `to be unique within a collection because they are the URL.`,
        ],
      },
    };
  }

  const before = value.itemId ? await getContentItem(value.itemId) : null;

  try {
    const result = await db.transaction(async (tx) => {
      const saved = await saveDraft({
        db: tx,
        itemId: value.itemId ?? undefined,
        type: value.type,
        slug: value.slug,
        title: value.title,
        data: value.data,
        excerpt: value.excerpt ?? null,
        locale: value.locale,
        sortOrder: value.sortOrder,
        status: value.status,
        publishAt: value.publishAt,
        unpublishAt: value.unpublishAt,
        summary: value.summary ?? null,
        actor: { userId: actor.userId, label: actor.label },
      });

      await recordAudit({
        db: tx,
        actor,
        action: saved.created ? "create" : "update",
        entity: "content_items",
        entityId: saved.item.id,
        before: before
          ? {
              title: before.item.title,
              slug: before.item.slug,
              status: before.item.status,
            }
          : undefined,
        after: {
          title: saved.item.title,
          slug: saved.item.slug,
          status: saved.item.status,
        },
        metadata: {
          module: "content",
          type: value.type,
          revision: saved.revision.revisionNumber,
          autosave: value.autosave,
        },
      });

      return saved;
    });

    revalidatePath("/admin/content");
    revalidatePath(`/admin/content/${value.type}`);
    revalidatePath(`/admin/content/${value.type}/${result.item.id}`);

    return {
      ok: true,
      itemId: result.item.id,
      revisionNumber: result.revision.revisionNumber,
      savedAt: result.revision.createdAt.toISOString(),
      created: result.created,
      slug: result.item.slug,
      message: result.created ? "Created." : "Saved.",
    };
  } catch (error) {
    console.error("[content] save failed", error);
    return {
      ok: false,
      message:
        "The save did not go through. Your text is still in the form — try " +
        "again, and copy it somewhere safe if it keeps failing.",
    };
  }
}

/* ------------------------------------------------------------- publish */

const publishSchema = z.object({
  itemIds: z.array(z.uuid()).min(1, "Tick at least one item.").max(500),
  note: z.string().trim().max(300).nullish(),
});

/**
 * PUBLISH. Promotes the newest revision of each item to live, opens a
 * content_publishes row, commits, and only then fires the deploy hook.
 *
 * The validation gate is repeated here even though the queue disables the
 * checkbox for a failing item: a server action is a POST endpoint reachable
 * from anywhere, and "the checkbox was disabled" is a statement about one
 * browser, not about what arrives.
 */
export async function publishContent(
  input: PublishContentInput,
): Promise<PublishContentResult> {
  const actor = await requireStaff();

  const parsed = publishSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: z.flattenError(parsed.error).formErrors.join(" ") ||
        "Nothing was selected.",
    };
  }

  const types = await listContentTypes();
  const fieldsByType = new Map(
    types.map((t) => [t.key, editorFields(t.fields)]),
  );

  const cleared: string[] = [];
  const blocked: PublishContentResult["blocked"] = [];

  for (const itemId of parsed.data.itemIds) {
    const detail = await getContentItem(itemId);
    if (!detail) continue;

    const fields = fieldsByType.get(detail.item.type) ?? [];

    // Validate WHAT WILL GO LIVE, which is the newest revision — not
    // content_items.data. They agree in every write path this application
    // has, and checking the one that is actually promoted means they cannot
    // quietly stop agreeing.
    const source = detail.latestRevision ?? {
      title: detail.item.title,
      slug: detail.item.slug,
      excerpt: detail.item.excerpt,
      data: detail.item.data,
    };

    const assetRows = await getAssetsByKeys(
      collectAssetKeys(fields, source.data),
    );
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

    const report = validateContent({
      type: detail.item.type,
      title: source.title,
      slug: source.slug,
      sortOrder: detail.item.sortOrder,
      excerpt: source.excerpt,
      data: source.data,
      fields,
      assets,
    });

    if (report.ok) cleared.push(itemId);
    else
      blocked.push({
        itemId,
        title: detail.item.title,
        issues: report.errors as ContentIssue[],
      });
  }

  if (!cleared.length) {
    return {
      ok: false,
      message: blocked.length
        ? "Nothing was published: every item selected would fail the site build."
        : "Nothing was published — those items no longer exist.",
      blocked,
    };
  }

  const run = await db.transaction(async (tx) => {
    const result = await publishItems({
      db: tx,
      itemIds: cleared,
      note: parsed.data.note ?? null,
      actor: { userId: actor.userId, label: actor.label },
    });

    for (const itemId of result.publishedItemIds) {
      await recordAudit({
        db: tx,
        actor,
        action: "status-change",
        entity: "content_items",
        entityId: itemId,
        after: { status: "published" },
        metadata: { module: "content", publishId: result.publishId },
      });
    }

    await recordAudit({
      db: tx,
      actor,
      action: "create",
      entity: "content_publishes",
      entityId: result.publishId,
      after: {
        itemCount: result.publishedItemIds.length,
        note: parsed.data.note ?? null,
      },
      metadata: {
        module: "content",
        skipped: result.skippedItemIds.length,
        blocked: blocked.length,
      },
    });

    return result;
  });

  // AFTER the commit. A rebuild that starts against data which then rolls
  // back would put a snapshot on the public site that no longer exists.
  const deployment = await dispatchDeploy(run.publishId);

  revalidatePath("/admin/content");
  revalidatePath("/admin/content/publish");

  const count = run.publishedItemIds.length;
  return {
    ok: true,
    publishId: run.publishId,
    publishedCount: count,
    skipped: run.skippedItemIds,
    blocked,
    deployment,
    message:
      `Published ${count} item${count === 1 ? "" : "s"}. ` +
      deployment.detail +
      (blocked.length
        ? ` ${blocked.length} item${blocked.length === 1 ? " was" : "s were"} held back — see below.`
        : ""),
  };
}

/**
 * Fire the hook and record what it said. Shared by publishContent() and the
 * "retry deployment" button on the publish log, so a failed rebuild is
 * retryable without republishing anything.
 */
async function dispatchDeploy(
  publishId: string,
): Promise<NonNullable<PublishContentResult["deployment"]>> {
  const result = await fireDeployHook();

  if (!result.fired) {
    await recordPublishDispatch({
      publishId,
      status: "succeeded",
      deployHookStatus: null,
      deployHookResponse: { note: "VERCEL_DEPLOY_HOOK_URL is not set." },
      error: null,
    });
    console.warn(
      "[content] published with no deploy hook configured — the API snapshot " +
        "is current, the public site will pick it up on its next build.",
    );
    return {
      fired: false,
      ok: true,
      status: null,
      url: null,
      detail:
        "No deploy hook is configured, so the site was not rebuilt. The " +
        "published snapshot is live at /api/content immediately.",
    };
  }

  await recordPublishDispatch({
    publishId,
    status: result.ok ? "succeeded" : "failed",
    deployHookStatus: result.status,
    deployHookResponse: result.response,
    deploymentId: result.deploymentId,
    deploymentUrl: result.deploymentUrl,
    error: result.error,
  });

  return {
    fired: true,
    ok: result.ok,
    status: result.status,
    url: result.deploymentUrl,
    detail: result.ok
      ? "The site is rebuilding."
      : (result.error ?? "The deploy hook failed."),
  };
}

/** Re-fire the deploy hook for an existing publish run. */
export async function retryDeployment(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const publishId = String(formData.get("publishId") ?? "");
  if (!z.uuid().safeParse(publishId).success) {
    return fail("That publish run does not exist.");
  }
  if (!deployHookConfigured()) {
    return fail(
      "VERCEL_DEPLOY_HOOK_URL is not set in this deployment, so there is " +
        "nothing to retry. Set it and publish again.",
    );
  }

  const result = await dispatchDeploy(publishId);
  await recordAudit({
    actor,
    action: "update",
    entity: "content_publishes",
    entityId: publishId,
    after: { deployRetried: true, ok: result.ok },
    metadata: { module: "content" },
  });

  revalidatePath("/admin/content/publish");
  return result.ok
    ? ok("Deploy hook fired. The site is rebuilding.")
    : fail(result.detail);
}

/* ------------------------------------------------------------- restore */

export async function restoreRevisionAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const schema = z.object({
    itemId: z.uuid(),
    revisionId: z.uuid(),
  });
  const parsed = schema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);

  const detail = await getContentItem(parsed.data.itemId);
  if (!detail) return fail("That item no longer exists.");

  try {
    const result = await db.transaction(async (tx) => {
      const restored = await restoreRevision({
        db: tx,
        itemId: parsed.data.itemId,
        revisionId: parsed.data.revisionId,
        actor: { userId: actor.userId, label: actor.label },
      });
      await recordAudit({
        db: tx,
        actor,
        action: "restore",
        entity: "content_items",
        entityId: parsed.data.itemId,
        before: { title: detail.item.title, slug: detail.item.slug },
        after: {
          title: restored.item.title,
          slug: restored.item.slug,
          revision: restored.revision.revisionNumber,
        },
        metadata: {
          module: "content",
          restoredFrom: parsed.data.revisionId,
        },
      });
      return restored;
    });

    revalidatePath(`/admin/content/${detail.item.type}/${detail.item.id}`);
    revalidatePath(
      `/admin/content/${detail.item.type}/${detail.item.id}/history`,
    );
    revalidatePath("/admin/content");

    return ok(
      `Restored as revision ${result.revision.revisionNumber}. Nothing has ` +
        `changed on the public site — publish it when you are happy.`,
      { revisionNumber: result.revision.revisionNumber },
    );
  } catch (error) {
    console.error("[content] restore failed", error);
    return fail("That revision does not belong to this item.");
  }
}

/* ------------------------------------------------------------- archive */

export async function archiveContentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const parsed = z
    .object({ itemId: z.uuid(), archive: checkboxSchema })
    .safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);

  const detail = await getContentItem(parsed.data.itemId);
  if (!detail) return fail("That item no longer exists.");

  const nextStatus = parsed.data.archive ? "archived" : "draft";

  await db.transaction(async (tx) => {
    await tx
      .update(contentItems)
      .set({
        status: nextStatus,
        // Taking an item down means it is no longer live. Leaving
        // published_revision_id set would keep it in the API snapshot, and a
        // CHECK forbids status 'published' without one anyway.
        ...(parsed.data.archive ? { publishedRevisionId: null } : {}),
        updatedBy: actor.userId,
      })
      .where(eq(contentItems.id, parsed.data.itemId));

    await recordAudit({
      db: tx,
      actor,
      action: parsed.data.archive ? "archive" : "restore",
      entity: "content_items",
      entityId: parsed.data.itemId,
      before: { status: detail.item.status },
      after: { status: nextStatus },
      metadata: { module: "content", type: detail.item.type },
    });
  });

  revalidatePath("/admin/content");
  revalidatePath(`/admin/content/${detail.item.type}`);
  revalidatePath(`/admin/content/${detail.item.type}/${detail.item.id}`);

  return ok(
    parsed.data.archive
      ? "Archived and taken off the public site at the next build."
      : "Back in drafts.",
  );
}

/* --------------------------------------------------------------- media */

const MAX_ASSET_BYTES = 20 * 1024 * 1024;

const assetMetaSchema = z.object({
  altText: z.string().trim().max(500).nullish(),
  isDecorative: checkboxSchema,
  credit: z.string().trim().max(300).nullish(),
  aiGenerated: checkboxSchema,
  aiNote: z.string().trim().max(500).nullish(),
  longDescription: z.string().trim().max(4000).nullish(),
  width: z.coerce.number().int().positive().nullish(),
  height: z.coerce.number().int().positive().nullish(),
});

function assetKeyFor(filename: string): string {
  const safe = filename
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-120);
  const year = new Date().getUTCFullYear();
  return `content/${year}/${crypto.randomUUID().slice(0, 8)}-${safe || "file"}`;
}

/**
 * Upload one file into the media library.
 *
 * The alt-text rule is enforced in three places and this is the third:
 * the form disables its own submit button and says why, createAssetSchema
 * refuses the insert with a sentence, and content_assets carries a CHECK.
 * The first is courtesy, the second is the message, the third is the
 * guarantee.
 */
export async function uploadAssetAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return fail("Choose a file to upload.");
  }
  if (file.size > MAX_ASSET_BYTES) {
    return fail(
      `That file is ${Math.round(file.size / 1024 / 1024)} MB. The limit here is 20 MB.`,
    );
  }

  const meta = assetMetaSchema.safeParse(formToObject(formData));
  if (!meta.success) return invalid(meta.error);

  const mime = file.type || "application/octet-stream";
  const key = assetKeyFor(file.name);

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Object storage is not provisioned in this container. The row is written
    // either way and the library says plainly which files have no bytes
    // behind them — the same posture as the document library.
    const stored = await putDocumentObject(key, bytes, mime);

    const asset = await db.transaction(async (tx) => {
      const row = await createAsset({
        db: tx,
        key,
        filename: file.name,
        mime,
        bytes: file.size,
        width: meta.data.width ?? null,
        height: meta.data.height ?? null,
        altText: meta.data.altText ?? null,
        isDecorative: meta.data.isDecorative,
        credit: meta.data.credit ?? null,
        aiGenerated: meta.data.aiGenerated,
        aiNote: meta.data.aiNote ?? null,
        longDescription: meta.data.longDescription ?? null,
        uploadedBy: actor.userId,
      });
      await recordAudit({
        db: tx,
        actor,
        action: "create",
        entity: "content_assets",
        entityId: row.id,
        after: {
          filename: row.filename,
          mime: row.mime,
          bytes: row.bytes,
          hasAltText: Boolean(row.altText),
          isDecorative: row.isDecorative,
        },
        metadata: { module: "content", stored: stored.stored },
      });
      return row;
    });

    revalidatePath("/admin/content/media");
    return ok(
      stored.stored
        ? `Uploaded ${asset.filename}.`
        : `${asset.filename} is catalogued. Object storage is not configured in ` +
            `this deployment, so the bytes were not stored — the library marks it.`,
      { assetId: asset.id },
    );
  } catch (error) {
    if (error instanceof z.ZodError) return invalid(error);
    console.error("[content] asset upload failed", error);
    return fail("The upload did not go through.");
  }
}

/** Edit an asset's description, credit and provenance. */
export async function updateAssetAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const parsed = assetMetaSchema
    .extend({ assetId: z.uuid() })
    .safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);

  const [existing] = await db
    .select()
    .from(contentAssets)
    .where(eq(contentAssets.id, parsed.data.assetId))
    .limit(1);
  if (!existing) return fail("That file is not in the library.");

  // The same rule createAssetSchema enforces, applied to an edit: an image
  // may not be stripped of its alt text after the fact.
  if (existing.mime.startsWith("image/")) {
    if (parsed.data.isDecorative && parsed.data.altText?.trim()) {
      return {
        status: "error",
        message: "Fix the highlighted fields and try again.",
        fieldErrors: {
          altText: [
            'A decorative image renders as alt="". Either describe it or mark ' +
              "it decorative, not both.",
          ],
        },
      };
    }
    if (!parsed.data.isDecorative && !parsed.data.altText?.trim()) {
      return {
        status: "error",
        message: "Fix the highlighted fields and try again.",
        fieldErrors: {
          altText: [
            "Alt text is required on images. If this image carries no " +
              "information, tick “decorative” instead.",
          ],
        },
      };
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .update(contentAssets)
      .set({
        altText: parsed.data.altText ?? null,
        isDecorative: parsed.data.isDecorative,
        credit: parsed.data.credit ?? null,
        aiGenerated: parsed.data.aiGenerated,
        aiNote: parsed.data.aiNote ?? null,
        longDescription: parsed.data.longDescription ?? null,
        updatedAt: new Date(),
      })
      .where(eq(contentAssets.id, parsed.data.assetId));

    await recordAudit({
      db: tx,
      actor,
      action: "update",
      entity: "content_assets",
      entityId: parsed.data.assetId,
      before: {
        altText: existing.altText,
        isDecorative: existing.isDecorative,
        credit: existing.credit,
      },
      after: {
        altText: parsed.data.altText ?? null,
        isDecorative: parsed.data.isDecorative,
        credit: parsed.data.credit ?? null,
      },
      metadata: { module: "content" },
    });
  });

  revalidatePath("/admin/content/media");
  return ok("Saved.");
}

/**
 * Replace the bytes behind an asset, keeping the row, its key, and every
 * reference to it. This is the whole point of having a key: a logo that
 * changes should not orphan the twelve pages that point at it.
 */
export async function replaceAssetAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const assetId = String(formData.get("assetId") ?? "");
  if (!z.uuid().safeParse(assetId).success) {
    return fail("That file is not in the library.");
  }
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return fail("Choose the replacement file.");
  }
  if (file.size > MAX_ASSET_BYTES) {
    return fail("That file is over the 20 MB limit.");
  }

  const [existing] = await db
    .select()
    .from(contentAssets)
    .where(eq(contentAssets.id, assetId))
    .limit(1);
  if (!existing) return fail("That file is not in the library.");

  const mime = file.type || existing.mime;
  if (
    existing.mime.startsWith("image/") !== mime.startsWith("image/")
  ) {
    return fail(
      "The replacement has to be the same kind of file. Swapping an image " +
        "for a PDF would leave alt text describing something that is no " +
        "longer there.",
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const stored = await putDocumentObject(existing.key, bytes, mime);

  const width = Number(formData.get("width"));
  const height = Number(formData.get("height"));

  await db.transaction(async (tx) => {
    await tx
      .update(contentAssets)
      .set({
        filename: file.name,
        mime,
        bytes: file.size,
        width: Number.isFinite(width) && width > 0 ? width : existing.width,
        height: Number.isFinite(height) && height > 0 ? height : existing.height,
        updatedAt: new Date(),
      })
      .where(eq(contentAssets.id, assetId));

    await recordAudit({
      db: tx,
      actor,
      action: "update",
      entity: "content_assets",
      entityId: assetId,
      before: { filename: existing.filename, bytes: existing.bytes },
      after: { filename: file.name, bytes: file.size },
      metadata: { module: "content", replaced: true, stored: stored.stored },
    });
  });

  revalidatePath("/admin/content/media");
  return ok(
    stored.stored
      ? `Replaced. Every page pointing at this file now shows the new one.`
      : `Row updated. Object storage is not configured here, so the bytes were ` +
          `not stored.`,
  );
}

export async function archiveAssetAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const parsed = z
    .object({ assetId: z.uuid(), archive: checkboxSchema })
    .safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);

  await db.transaction(async (tx) => {
    await tx
      .update(contentAssets)
      .set({
        archivedAt: parsed.data.archive ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(contentAssets.id, parsed.data.assetId));
    await recordAudit({
      db: tx,
      actor,
      action: parsed.data.archive ? "archive" : "restore",
      entity: "content_assets",
      entityId: parsed.data.assetId,
      after: { archived: parsed.data.archive },
      metadata: { module: "content" },
    });
  });

  revalidatePath("/admin/content/media");
  return ok(
    parsed.data.archive
      ? "Archived. Pages already pointing at it keep working — archiving hides " +
          "it from the picker, it does not delete the file."
      : "Back in the library.",
  );
}

/** Whether this deployment can rebuild the site. Read by the publish page. */
export async function deployHookStatus(): Promise<{
  configured: boolean;
  storage: boolean;
}> {
  await requireStaff();
  return {
    configured: deployHookConfigured(),
    storage: storageIsConfigured(),
  };
}
