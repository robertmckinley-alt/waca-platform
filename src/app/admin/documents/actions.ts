"use server";
import { slugify as sharedSlugify } from "@/lib/slug";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { documents } from "@/db/schema";
import { requireStaff } from "@/lib/admin-auth";
import { recordAudit, diffFields, hasChanges } from "@/lib/audit";
import {
  fail,
  formList,
  formToObject,
  invalid,
  ok,
  type ActionState,
} from "@/lib/action-state";
import { DOCUMENT_CATEGORIES } from "@/lib/documents/labels";
import { putDocumentObject, storageIsConfigured } from "@/lib/documents/storage";

/**
 * ==========================================================================
 *  DOCUMENT LIBRARY — staff actions.
 *
 *  Every write is: requireStaff() -> Zod -> transaction -> audit_log ->
 *  revalidatePath. Access scope is DATA, not code: these actions set
 *  `accessScope` / `levelRestrictions` / `councilRestrictions` and the single
 *  predicate in @/db/queries/documents decides who may read the row. There is
 *  no second access check here and there must never be one.
 * ==========================================================================
 */

/** THE slugifier, capped at the documents table's slug length. */
const slugify = (value: string) => sharedSlugify(value, 80);

const csvList = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const baseSchema = z.object({
  title: z.string().trim().min(3, "Give the document a title").max(300),
  description: z
    .string()
    .max(2000)
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : null)),
  category: z.enum(DOCUMENT_CATEGORIES as [string, ...string[]]),
  accessScope: z.enum([
    "public",
    "members",
    "level-restricted",
    "council-restricted",
  ]),
  policyYear: z
    .string()
    .optional()
    .transform((v) => (v && /^\d{4}$/.test(v.trim()) ? Number(v.trim()) : null)),
  councilId: z
    .string()
    .optional()
    .transform((v) => (v && v.length ? v : null)),
  eventId: z
    .string()
    .optional()
    .transform((v) => (v && v.length ? v : null)),
  tags: csvList,
  relatedBills: csvList,
  publish: z
    .union([z.literal("on"), z.literal("")])
    .optional()
    .transform((v) => v === "on"),
});

/**
 * The restriction arrays only mean anything for their own scope. Clearing the
 * other one on save stops a document that was council-restricted last week and
 * is level-restricted today from carrying a stale council list that a future
 * scope change would silently re-activate.
 */
function restrictionsFor(
  scope: string,
  levels: string[],
  councils: string[],
): { levelRestrictions: string[]; councilRestrictions: string[] } {
  return {
    levelRestrictions: scope === "level-restricted" ? levels : [],
    councilRestrictions: scope === "council-restricted" ? councils : [],
  };
}

function validateScope(
  scope: string,
  levels: string[],
  councils: string[],
): string | null {
  if (scope === "level-restricted" && levels.length === 0)
    return "Pick at least one membership level, or the document reaches nobody.";
  if (scope === "council-restricted" && councils.length === 0)
    return "Pick at least one council, or the document reaches nobody.";
  return null;
}

/* ------------------------------------------------------------ create */

export async function createDocument(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();

  const parsed = baseSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;

  const levels = formList(formData, "levelRestrictions");
  const councils = formList(formData, "councilRestrictions");
  const scopeError = validateScope(input.accessScope, levels, councils);
  if (scopeError) return fail(scopeError);

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return fail("Choose a file to upload.");
  }
  if (file.size > 50 * 1024 * 1024) {
    return fail("That file is over 50 MB. Split it or compress it first.");
  }

  const slugBase = slugify(input.title) || "document";
  const bytes = new Uint8Array(await file.arrayBuffer());
  const fileKey = `${input.category}/${Date.now()}-${slugBase}`;

  // Push the bytes at object storage. When Supabase is not provisioned this
  // returns `stored: false` and we keep the metadata row anyway — the library,
  // the access rules and the download route are all exercisable, and the
  // download hands back a placeholder that says so. It does NOT pretend the
  // file is there.
  const put = await putDocumentObject(fileKey, bytes, file.type);

  let slug = slugBase;
  let documentId = "";

  await db.transaction(async (tx) => {
    // Slugs are unique; append a counter rather than 500 on a name collision.
    for (let n = 2; n < 50; n += 1) {
      const [clash] = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.slug, slug))
        .limit(1);
      if (!clash) break;
      slug = `${slugBase}-${n}`;
    }

    const [row] = await tx
      .insert(documents)
      .values({
        title: input.title,
        slug,
        description: input.description,
        category: input.category as never,
        accessScope: input.accessScope as never,
        ...restrictionsFor(input.accessScope, levels, councils),
        fileKey,
        fileName: file.name,
        mime: file.type || "application/octet-stream",
        bytes: file.size,
        policyYear: input.policyYear,
        councilId: input.councilId,
        eventId: input.eventId,
        tags: input.tags,
        relatedBills: input.relatedBills,
        publishedOn: input.publish
          ? new Date().toISOString().slice(0, 10)
          : null,
        uploadedByContactId: actor.contactId,
      })
      .returning({ id: documents.id });

    documentId = row.id;

    await recordAudit({
      db: tx,
      actor,
      action: "create",
      entity: "documents",
      entityId: row.id,
      after: {
        title: input.title,
        category: input.category,
        accessScope: input.accessScope,
        published: input.publish,
        bytes: file.size,
      },
      metadata: {
        objectStored: put.stored,
        storageConfigured: storageIsConfigured(),
      },
    });
  });

  revalidatePath("/admin/documents");
  revalidatePath("/portal/library");
  redirect(`/admin/documents/${documentId}`);
}

/* ------------------------------------------------------------ update */

export async function updateDocument(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();

  const id = formData.get("documentId");
  if (typeof id !== "string" || !z.uuid().safeParse(id).success) {
    return fail("Missing document.");
  }

  const parsed = baseSchema.omit({ publish: true }).safeParse(
    formToObject(formData),
  );
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;

  const levels = formList(formData, "levelRestrictions");
  const councils = formList(formData, "councilRestrictions");
  const scopeError = validateScope(input.accessScope, levels, councils);
  if (scopeError) return fail(scopeError);

  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1);
    if (!before) throw new Error("Document not found");

    const next = {
      title: input.title,
      description: input.description,
      category: input.category as never,
      accessScope: input.accessScope as never,
      ...restrictionsFor(input.accessScope, levels, councils),
      policyYear: input.policyYear,
      councilId: input.councilId,
      eventId: input.eventId,
      tags: input.tags,
      relatedBills: input.relatedBills,
      updatedAt: new Date(),
    };

    await tx.update(documents).set(next).where(eq(documents.id, id));

    const diff = diffFields(
      before as unknown as Record<string, unknown>,
      next as unknown as Record<string, unknown>,
    );
    if (hasChanges(diff)) {
      await recordAudit({
        db: tx,
        actor,
        action: "update",
        entity: "documents",
        entityId: id,
        before: diff.before,
        after: diff.after,
      });
    }
  });

  revalidatePath("/admin/documents");
  revalidatePath(`/admin/documents/${id}`);
  revalidatePath("/portal/library");
  return ok("Saved.");
}

/* --------------------------------------------- publish / archive */

const stateSchema = z.object({
  documentId: z.uuid(),
  action: z.enum(["publish", "unpublish", "archive", "restore"]),
});

export async function setDocumentState(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();

  const parsed = stateSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const { documentId, action } = parsed.data;

  const today = new Date().toISOString().slice(0, 10);

  const patch = {
    publish: { publishedOn: today },
    unpublish: { publishedOn: null },
    archive: { archivedAt: new Date() },
    restore: { archivedAt: null },
  }[action];

  await db.transaction(async (tx) => {
    await tx
      .update(documents)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(documents.id, documentId));

    await recordAudit({
      db: tx,
      actor,
      action: action === "archive" ? "archive" : "update",
      entity: "documents",
      entityId: documentId,
      after: patch as Record<string, unknown>,
      metadata: { reason: `document-${action}` },
    });
  });

  revalidatePath("/admin/documents");
  revalidatePath(`/admin/documents/${documentId}`);
  revalidatePath("/portal/library");

  return ok(
    {
      publish: "Published. Members in scope can see it now.",
      unpublish: "Unpublished. It is hidden from the member library.",
      archive: "Archived.",
      restore: "Restored.",
    }[action],
  );
}
