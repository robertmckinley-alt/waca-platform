"use server";

import { and, count, eq, isNull, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import { contacts } from "@/db/schema";
import {
  checkboxSchema,
  fail,
  formToObject,
  invalid,
  ok,
  type ActionState,
} from "@/lib/action-state";
import { requireBundleAdmin } from "@/lib/portal/session";
import { recordAudit } from "@/lib/audit";

/**
 * BUNDLE ADMINISTRATION.
 *
 * A 21-contact bundle is currently maintained by emailing WACA staff. These
 * four actions are how it gets maintained instead.
 *
 * Every one of them:
 *   · re-resolves the session through requireBundleAdmin() — the button that
 *     was rendered proves nothing about the POST that arrives;
 *   · pins every write to `organizationId` from that session, so a contact id
 *     belonging to another bundle simply matches no row;
 *   · refuses to leave the bundle without a bundle administrator or without a
 *     primary contact, because that state can only be fixed by staff.
 *
 * Contacts are ARCHIVED, never deleted: invoices, registrations and council
 * seats point at them and the history has to survive.
 */

interface BundleActor {
  organizationId: string;
  contactId: string;
  userId: string;
  label: string;
}

async function audit(
  actor: BundleActor,
  action: "create" | "update" | "archive",
  entityId: string,
  metadata: Record<string, unknown>,
) {
  try {
    // recordAudit() is the ONE writer of audit_log in this codebase. This used
    // to insert directly, which meant a change to the trail's shape would have
    // silently skipped anything a bundle administrator did.
    await recordAudit({
      actor: {
        userId: actor.userId,
        contactId: actor.contactId,
        label: actor.label,
      },
      action,
      entity: "contacts",
      entityId,
      metadata: { ...metadata, via: "member-portal", bundle: actor.organizationId },
    });
  } catch (error) {
    console.error("[portal] bundle audit failed", error);
  }
}

/** Contact must exist, be live, and belong to THIS bundle. */
async function loadBundleContact(organizationId: string, contactId: string) {
  const [row] = await db
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.id, contactId),
        eq(contacts.organizationId, organizationId),
        isNull(contacts.archivedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function countBundleAdmins(organizationId: string, excludingContactId?: string) {
  const [row] = await db
    .select({ value: count() })
    .from(contacts)
    .where(
      and(
        eq(contacts.organizationId, organizationId),
        eq(contacts.isBundleAdmin, true),
        isNull(contacts.archivedAt),
        excludingContactId ? ne(contacts.id, excludingContactId) : undefined,
      ),
    );
  return Number(row?.value ?? 0);
}

/* ------------------------------------------------------------ add contact */

const addSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(120),
  lastName: z.string().trim().min(1, "Last name is required").max(120),
  email: z.string().trim().min(1, "Email address is required").pipe(z.email()),
  title: z
    .preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? null : v),
      z.string().trim().max(160).nullable(),
    )
    .default(null),
  phone: z
    .preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? null : v),
      z.string().trim().max(40).nullable(),
    )
    .default(null),
  isBundleAdmin: checkboxSchema,
});

export async function addBundleContactAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireBundleAdmin();
  const parsed = addSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);

  const actor: BundleActor = {
    organizationId: context.organizationId,
    contactId: context.contactId,
    userId: context.userId,
    label: context.data.contact.displayName,
  };

  // contacts.email is globally unique, case-insensitively. Say something
  // useful rather than surfacing a constraint violation.
  const [existing] = await db
    .select({ id: contacts.id, organizationId: contacts.organizationId })
    .from(contacts)
    .where(sql`lower(${contacts.email}) = lower(${parsed.data.email})`)
    .limit(1);

  if (existing) {
    return fail(
      existing.organizationId === context.organizationId
        ? "That email address is already on your bundle. If the person was removed, ask WACA staff to restore them rather than adding a duplicate."
        : "That email address already belongs to another WACA record. Staff can move it onto your bundle — email info@example.org.",
    );
  }

  const [created] = await db
    .insert(contacts)
    .values({
      firstName: parsed.data.firstName,
      lastName: parsed.data.lastName,
      displayName: `${parsed.data.firstName} ${parsed.data.lastName}`,
      email: parsed.data.email,
      title: parsed.data.title,
      phone: parsed.data.phone,
      organizationId: context.organizationId,
      isBundleAdmin: parsed.data.isBundleAdmin,
      isPrimaryContact: false,
    })
    .returning({ id: contacts.id });

  await audit(actor, "create", created.id, {
    email: parsed.data.email,
    isBundleAdmin: parsed.data.isBundleAdmin,
  });

  revalidatePath("/portal/organization");

  return ok(
    `${parsed.data.firstName} ${parsed.data.lastName} added to the bundle. They can sign in with ${parsed.data.email} using a magic link — no password to set up.`,
  );
}

/* --------------------------------------------------------- remove contact */

const contactIdSchema = z.object({ contactId: z.uuid() });

export async function removeBundleContactAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireBundleAdmin();
  const parsed = contactIdSchema.safeParse(formToObject(formData));
  if (!parsed.success) return fail("That contact could not be found on your bundle.");

  const target = await loadBundleContact(context.organizationId, parsed.data.contactId);
  if (!target) return fail("That contact could not be found on your bundle.");

  if (target.id === context.contactId) {
    return fail(
      "You cannot remove yourself. Hand the bundle administrator role to a colleague first, then ask them to remove you.",
    );
  }
  if (target.isPrimaryContact) {
    return fail(
      "That is the primary contact for the membership. Make someone else the primary contact first — renewal notices and invoices go to them.",
    );
  }
  if (target.isBundleAdmin && (await countBundleAdmins(context.organizationId, target.id)) === 0) {
    return fail(
      "That is the only bundle administrator. Give someone else the role first, or the bundle will have nobody who can manage it.",
    );
  }

  await db
    .update(contacts)
    .set({ archivedAt: new Date(), isBundleAdmin: false, updatedAt: new Date() })
    .where(
      and(
        eq(contacts.id, target.id),
        eq(contacts.organizationId, context.organizationId),
      ),
    );

  await audit(
    {
      organizationId: context.organizationId,
      contactId: context.contactId,
      userId: context.userId,
      label: context.data.contact.displayName,
    },
    "archive",
    target.id,
    { email: target.email },
  );

  revalidatePath("/portal/organization");

  return ok(
    `${target.displayName} removed from the bundle. Their event history and invoices are kept — WACA staff can restore the record if this was a mistake.`,
  );
}

/* ------------------------------------------------------ bundle admin role */

const roleSchema = z.object({
  contactId: z.uuid(),
  value: z.enum(["on", "off"]),
});

export async function setBundleAdminAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireBundleAdmin();
  const parsed = roleSchema.safeParse(formToObject(formData));
  if (!parsed.success) return fail("That contact could not be found on your bundle.");

  const target = await loadBundleContact(context.organizationId, parsed.data.contactId);
  if (!target) return fail("That contact could not be found on your bundle.");

  const next = parsed.data.value === "on";

  if (!next && (await countBundleAdmins(context.organizationId, target.id)) === 0) {
    return fail(
      "Someone has to be able to manage the bundle. Give another contact the role before removing this one.",
    );
  }

  await db
    .update(contacts)
    .set({ isBundleAdmin: next, updatedAt: new Date() })
    .where(
      and(
        eq(contacts.id, target.id),
        eq(contacts.organizationId, context.organizationId),
      ),
    );

  await audit(
    {
      organizationId: context.organizationId,
      contactId: context.contactId,
      userId: context.userId,
      label: context.data.contact.displayName,
    },
    "update",
    target.id,
    { isBundleAdmin: next },
  );

  revalidatePath("/portal/organization");

  return ok(
    next
      ? `${target.displayName} can now manage this bundle's contacts.`
      : `${target.displayName} is no longer a bundle administrator.`,
  );
}

/* -------------------------------------------------------- primary contact */

export async function setPrimaryContactAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requireBundleAdmin();
  const parsed = contactIdSchema.safeParse(formToObject(formData));
  if (!parsed.success) return fail("That contact could not be found on your bundle.");

  const target = await loadBundleContact(context.organizationId, parsed.data.contactId);
  if (!target) return fail("That contact could not be found on your bundle.");
  if (target.isPrimaryContact) {
    return ok(`${target.displayName} is already the primary contact.`);
  }

  // One primary per organisation is a partial unique index, so the swap has to
  // happen in one transaction or the insert order can violate it.
  await db.transaction(async (tx) => {
    await tx
      .update(contacts)
      .set({ isPrimaryContact: false, updatedAt: new Date() })
      .where(
        and(
          eq(contacts.organizationId, context.organizationId),
          eq(contacts.isPrimaryContact, true),
        ),
      );
    await tx
      .update(contacts)
      .set({ isPrimaryContact: true, updatedAt: new Date() })
      .where(
        and(
          eq(contacts.id, target.id),
          eq(contacts.organizationId, context.organizationId),
        ),
      );
  });

  await audit(
    {
      organizationId: context.organizationId,
      contactId: context.contactId,
      userId: context.userId,
      label: context.data.contact.displayName,
    },
    "update",
    target.id,
    { isPrimaryContact: true },
  );

  revalidatePath("/portal/organization");
  revalidatePath("/portal");

  return ok(
    `${target.displayName} is now the primary contact. Renewal notices and invoices go to them.`,
  );
}
