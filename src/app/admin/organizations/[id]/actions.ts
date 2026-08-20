"use server";

import { revalidatePath } from "next/cache";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { contacts, memberships, organizations } from "@/db/schema";
import { requireStaff } from "@/lib/admin-auth";
import { diffFields, hasChanges, recordAudit } from "@/lib/audit";
import {
  checkboxSchema,
  fail,
  formToObject,
  invalid,
  ok,
  type ActionState,
} from "@/lib/action-state";

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

const optionalDate = z
  .string()
  .optional()
  .transform((v) => (v && v.length ? v : null))
  .refine((v) => v === null || /^\d{4}-\d{2}-\d{2}$/.test(v), {
    message: "Use YYYY-MM-DD",
  });

/* ------------------------------------------------------- organisation */

const updateOrganizationSchema = z.object({
  organizationId: z.uuid(),
  legalName: z.string().trim().min(1, "Required").max(200),
  displayName: z.string().trim().min(1, "Required").max(200),
  category: z.enum([
    "retailer",
    "producer-processor",
    "lab-transport",
    "ancillary",
  ]),
  revenueBand: z.enum([
    "over-5m",
    "1m-4.9m",
    "150k-1m",
    "under-1m",
    "under-150k",
    "not-disclosed",
  ]),
  website: optionalText(300),
  phone: optionalText(40),
  email: optionalText(200),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(120),
  state: optionalText(40),
  postalCode: optionalText(20),
  memberSince: optionalDate,
  publicDescription: optionalText(2000),
  notes: optionalText(4000),
  publicListingConsent: checkboxSchema,
  archived: checkboxSchema,
});

export async function updateOrganization(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();

  const parsed = updateOrganizationSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;

  if (input.email && !z.email().safeParse(input.email).success) {
    return {
      status: "error",
      message: "Fix the highlighted fields and try again.",
      fieldErrors: { email: ["Enter a valid email address"] },
    };
  }

  const [existing] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .limit(1);
  if (!existing) return fail("That organisation no longer exists.");

  const next = {
    legalName: input.legalName,
    displayName: input.displayName,
    category: input.category,
    revenueBand: input.revenueBand,
    website: input.website,
    phone: input.phone,
    email: input.email,
    addressLine1: input.addressLine1,
    addressLine2: input.addressLine2,
    city: input.city,
    state: input.state,
    postalCode: input.postalCode,
    memberSince: input.memberSince ? new Date(input.memberSince) : null,
    publicDescription: input.publicDescription,
    notes: input.notes,
    publicListingConsent: input.publicListingConsent,
    archivedAt: input.archived ? (existing.archivedAt ?? new Date()) : null,
  };

  const diff = diffFields(
    existing as unknown as Record<string, unknown>,
    next as unknown as Record<string, unknown>,
  );
  if (!hasChanges(diff)) return ok("Nothing to save — no fields changed.");

  await db.transaction(async (tx) => {
    await tx
      .update(organizations)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(organizations.id, input.organizationId));
    await recordAudit({
      db: tx,
      actor,
      action: input.archived && !existing.archivedAt ? "archive" : "update",
      entity: "organizations",
      entityId: input.organizationId,
      before: diff.before,
      after: diff.after,
    });
  });

  revalidatePath(`/admin/organizations/${input.organizationId}`);
  revalidatePath("/admin/organizations");
  return ok("Organisation saved.");
}

/* ----------------------------------------------------- contact roles */

const contactRoleSchema = z.object({
  organizationId: z.uuid(),
  contactId: z.uuid(),
  operation: z.enum([
    "grant-bundle-admin",
    "revoke-bundle-admin",
    "make-primary",
  ]),
});

/**
 * Designates bundle administrators and the primary billing contact.
 *
 * A bundle administrator may manage their own organisation's contacts, so this
 * is a privilege grant: it is audited, and only one primary contact per
 * organisation may exist (enforced by a partial unique index).
 */
export async function updateOrganizationContactRole(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();

  const parsed = contactRoleSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const { organizationId, contactId, operation } = parsed.data;

  const [contact] = await db
    .select()
    .from(contacts)
    .where(
      and(eq(contacts.id, contactId), eq(contacts.organizationId, organizationId)),
    )
    .limit(1);
  if (!contact) return fail("That contact is not in this organisation.");

  await db.transaction(async (tx) => {
    if (operation === "make-primary") {
      await tx
        .update(contacts)
        .set({ isPrimaryContact: false, updatedAt: new Date() })
        .where(
          and(
            eq(contacts.organizationId, organizationId),
            eq(contacts.isPrimaryContact, true),
            ne(contacts.id, contactId),
          ),
        );
      await tx
        .update(contacts)
        .set({ isPrimaryContact: true, updatedAt: new Date() })
        .where(eq(contacts.id, contactId));
    } else {
      await tx
        .update(contacts)
        .set({
          isBundleAdmin: operation === "grant-bundle-admin",
          updatedAt: new Date(),
        })
        .where(eq(contacts.id, contactId));
    }

    await recordAudit({
      db: tx,
      actor,
      action: "update",
      entity: "contacts",
      entityId: contactId,
      before:
        operation === "make-primary"
          ? { isPrimaryContact: contact.isPrimaryContact }
          : { isBundleAdmin: contact.isBundleAdmin },
      after:
        operation === "make-primary"
          ? { isPrimaryContact: true }
          : { isBundleAdmin: operation === "grant-bundle-admin" },
      metadata: { operation, organizationId },
    });
  });

  revalidatePath(`/admin/organizations/${organizationId}`);
  revalidatePath(`/admin/contacts/${contactId}`);
  return ok(
    operation === "make-primary"
      ? `${contact.displayName} is now the primary contact.`
      : operation === "grant-bundle-admin"
        ? `${contact.displayName} can now manage this bundle.`
        : `${contact.displayName} no longer manages this bundle.`,
  );
}

/* -------------------------------------------------------- membership */

const membershipSchema = z.object({
  organizationId: z.uuid(),
  membershipId: z.uuid(),
  levelId: z.uuid(),
  status: z.enum([
    "active",
    "renewal-overdue",
    "lapsed",
    "pending-new",
    "pending-renewal",
    "pending-level-change",
  ]),
  termStartsOn: optionalDate,
  expiresOn: optionalDate,
  autoRenew: checkboxSchema,
  notes: optionalText(2000),
});

/** Edits the organisation's CURRENT membership term. */
export async function updateMembership(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();

  const parsed = membershipSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;

  const [existing] = await db
    .select()
    .from(memberships)
    .where(eq(memberships.id, input.membershipId))
    .limit(1);
  if (!existing || existing.organizationId !== input.organizationId) {
    return fail("That membership no longer exists.");
  }

  const next = {
    levelId: input.levelId,
    status: input.status,
    termStartsOn: input.termStartsOn,
    expiresOn: input.expiresOn,
    autoRenew: input.autoRenew,
    notes: input.notes,
  };

  const diff = diffFields(
    existing as unknown as Record<string, unknown>,
    next as unknown as Record<string, unknown>,
  );
  if (!hasChanges(diff)) return ok("Nothing to save — no fields changed.");

  await db.transaction(async (tx) => {
    await tx
      .update(memberships)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(memberships.id, input.membershipId));
    await recordAudit({
      db: tx,
      actor,
      action: existing.status === input.status ? "update" : "status-change",
      entity: "memberships",
      entityId: input.membershipId,
      before: diff.before,
      after: diff.after,
      metadata: { organizationId: input.organizationId },
    });
  });

  revalidatePath(`/admin/organizations/${input.organizationId}`);
  revalidatePath("/admin/renewals");
  revalidatePath("/admin/members");
  return ok("Membership saved.");
}
