"use server";

import { revalidatePath } from "next/cache";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { contacts } from "@/db/schema";
import { requireStaff } from "@/lib/admin-auth";
import { diffFields, hasChanges, recordAudit } from "@/lib/audit";
import {
  checkboxSchema,
  formToObject,
  invalid,
  ok,
  type ActionState,
} from "@/lib/action-state";

/** "" -> null, trimmed, length-capped. */
function optionalText(max: number) {
  return z
    .string()
    .max(max)
    .optional()
    .transform((v) => {
      const t = v?.trim();
      return t ? t : null;
    });
}

const updateContactSchema = z.object({
  contactId: z.uuid(),
  firstName: z.string().trim().min(1, "Required").max(80),
  lastName: z.string().trim().min(1, "Required").max(80),
  email: z.email("Enter a valid email address").max(200),
  phone: optionalText(40),
  mobile: optionalText(40),
  title: optionalText(120),
  organizationId: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null))
    .refine((v) => v === null || z.uuid().safeParse(v).success, {
      message: "Unknown organisation",
    }),
  tags: z
    .string()
    .max(500)
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
        .filter((t, i, arr) => arr.indexOf(t) === i)
        .slice(0, 25),
    ),
  notes: optionalText(4000),
  isBundleAdmin: checkboxSchema,
  isPrimaryContact: checkboxSchema,
  emailOptIn: checkboxSchema,
  directoryOptIn: checkboxSchema,
  archived: checkboxSchema,
});

/**
 * Edits a contact. Zod-validated, audited, and transactional so the
 * "one primary contact per organisation" index can never be tripped by a
 * partially applied change.
 */
export async function updateContact(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();

  const parsed = updateContactSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;

  const [existing] = await db
    .select()
    .from(contacts)
    .where(eq(contacts.id, input.contactId))
    .limit(1);
  if (!existing) {
    return { status: "error", message: "That contact no longer exists." };
  }

  // Email is globally unique, case-insensitively.
  const [clash] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        sql`lower(${contacts.email}) = lower(${input.email})`,
        ne(contacts.id, input.contactId),
      ),
    )
    .limit(1);
  if (clash) {
    return {
      status: "error",
      message: "Another contact already uses that email address.",
      fieldErrors: { email: ["Already in use"] },
    };
  }

  const next = {
    firstName: input.firstName,
    lastName: input.lastName,
    displayName: `${input.firstName} ${input.lastName}`,
    email: input.email,
    phone: input.phone,
    mobile: input.mobile,
    title: input.title,
    organizationId: input.organizationId,
    tags: input.tags,
    notes: input.notes,
    isBundleAdmin: input.isBundleAdmin,
    isPrimaryContact: input.isPrimaryContact,
    emailOptIn: input.emailOptIn,
    directoryOptIn: input.directoryOptIn,
    archivedAt: input.archived ? (existing.archivedAt ?? new Date()) : null,
  };

  const diff = diffFields(
    existing as unknown as Record<string, unknown>,
    next as unknown as Record<string, unknown>,
  );
  if (!hasChanges(diff)) {
    return ok("Nothing to save — no fields changed.");
  }

  await db.transaction(async (tx) => {
    // Exactly one primary contact per organisation (partial unique index).
    if (next.isPrimaryContact && next.organizationId && !next.archivedAt) {
      await tx
        .update(contacts)
        .set({ isPrimaryContact: false, updatedAt: new Date() })
        .where(
          and(
            eq(contacts.organizationId, next.organizationId),
            eq(contacts.isPrimaryContact, true),
            ne(contacts.id, input.contactId),
          ),
        );
    }

    await tx
      .update(contacts)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(contacts.id, input.contactId));

    await recordAudit({
      db: tx,
      actor,
      action: input.archived && !existing.archivedAt ? "archive" : "update",
      entity: "contacts",
      entityId: input.contactId,
      before: diff.before,
      after: diff.after,
    });
  });

  revalidatePath(`/admin/contacts/${input.contactId}`);
  revalidatePath("/admin/contacts");
  if (next.organizationId) {
    revalidatePath(`/admin/organizations/${next.organizationId}`);
  }

  return ok("Contact saved.");
}
