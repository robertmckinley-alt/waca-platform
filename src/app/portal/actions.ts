"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import {
  membershipApplications,
  membershipLevels,
  memberships,
} from "@/db/schema";
import { fail, formToObject, invalid, ok, type ActionState } from "@/lib/action-state";
import { requirePortal, type PortalContext } from "@/lib/portal/session";

/**
 * MEMBERSHIP ACTIONS.
 *
 * Two rules hold across this file:
 *
 *  1. Every action re-resolves the session with requirePortal(). A server
 *     action is a public POST endpoint; the page that rendered the button
 *     proves nothing.
 *  2. A member NEVER mutates their own membership term, level or status. Renew
 *     and change-level write a `membership_applications` row for staff to
 *     approve. The single exception is `auto_renew`, which is explicitly a
 *     per-member override of the level default, and is the whole point of the
 *     feature.
 */

const OPEN_APPLICATION_STATUSES = ["submitted", "under-review"] as const;

/** Org-level financial decisions are the bundle administrator's to make. */
function canManageMembership(context: PortalContext): boolean {
  return (
    context.data.contact.isBundleAdmin ||
    context.data.contact.isPrimaryContact ||
    context.role === "admin" ||
    context.role === "staff"
  );
}

async function openApplicationExists(organizationId: string) {
  const [row] = await db
    .select({ id: membershipApplications.id })
    .from(membershipApplications)
    .where(
      and(
        eq(membershipApplications.organizationId, organizationId),
        inArray(membershipApplications.status, [...OPEN_APPLICATION_STATUSES]),
      ),
    )
    .limit(1);
  return row ?? null;
}

/* --------------------------------------------------------------- renewal */

/**
 * The one-click renew on the overview banner and the membership page.
 * Creates a renewal application; staff approve it, which is what raises the
 * invoice and rolls the term.
 */
export async function requestRenewalAction(
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  const context = await requirePortal();
  const { organization, membership } = context.data;

  if (!organization || !membership) {
    return fail(
      "We could not find a current membership on your organisation. Email WACA staff and they will sort it out.",
    );
  }

  const existing = await openApplicationExists(organization.id);
  if (existing) {
    return ok(
      "A renewal request is already with WACA staff — you do not need to send another. They will email you the invoice.",
    );
  }

  await db.insert(membershipApplications).values({
    type: "renewal",
    status: "submitted",
    organizationId: organization.id,
    membershipId: membership.id,
    requestedLevelId: membership.levelId,
    currentLevelId: membership.levelId,
    submittedByContactId: context.contactId,
    applicantPayload: {
      source: "member-portal",
      requestedBy: context.data.contact.displayName,
      requestedAt: new Date().toISOString(),
      levelAtRequest: membership.level.name,
      expiresOn: membership.expiresOn,
    },
  });

  revalidatePath("/portal");
  revalidatePath("/portal/membership");

  return ok(
    "Renewal requested. WACA staff will confirm your term and email the invoice — nothing is charged automatically and no card is involved.",
  );
}

/* ----------------------------------------------------------- auto-renewal */

const autoRenewSchema = z.object({
  autoRenew: z.enum(["on", "off"]),
});

/**
 * Auto-renewal is OFF on every level in Wild Apricot today and that is the
 * account's biggest revenue leak. Here it is a first-class, member-visible
 * switch that writes the per-membership override.
 */
export async function setAutoRenewAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requirePortal();
  const parsed = autoRenewSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);

  const { organization, membership } = context.data;
  if (!organization || !membership) {
    return fail("There is no current membership to set this on.");
  }
  if (!canManageMembership(context)) {
    return fail(
      "Only your bundle administrator or primary contact can change the renewal setting.",
    );
  }

  const next = parsed.data.autoRenew === "on";

  await db
    .update(memberships)
    .set({ autoRenew: next, updatedAt: new Date() })
    .where(
      and(
        eq(memberships.id, membership.id),
        // Belt and braces: the id came from this member's own context, and the
        // organisation is pinned again in the predicate.
        eq(memberships.organizationId, organization.id),
      ),
    );

  revalidatePath("/portal");
  revalidatePath("/portal/membership");

  return ok(
    next
      ? "Automatic renewal is on. WACA will raise your renewal invoice at the end of the term instead of letting the membership lapse."
      : "Automatic renewal is off. You will get the reminder ladder before expiry and will need to renew by hand.",
  );
}

/* ------------------------------------------------------------ level change */

const levelChangeSchema = z.object({
  levelId: z.uuid("Choose a membership level"),
  reason: z
    .preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? null : v),
      z.string().trim().max(2000).nullable(),
    )
    .default(null),
});

/**
 * Level change request. Writes an application — it does not touch the
 * membership. Eligibility is by revenue band and staff verify it.
 */
export async function requestLevelChangeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requirePortal();
  const parsed = levelChangeSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);

  const { organization, membership } = context.data;
  if (!organization || !membership) {
    return fail("There is no current membership to change.");
  }
  if (!canManageMembership(context)) {
    return fail(
      "Only your bundle administrator or primary contact can request a level change.",
    );
  }
  if (parsed.data.levelId === membership.levelId) {
    return fail(`You are already on ${membership.level.name}.`);
  }

  // The requested level must be one a member may actually apply for.
  const [level] = await db
    .select({
      id: membershipLevels.id,
      name: membershipLevels.name,
      isActive: membershipLevels.isActive,
      publicApplications: membershipLevels.publicApplications,
    })
    .from(membershipLevels)
    .where(eq(membershipLevels.id, parsed.data.levelId))
    .limit(1);

  if (!level || !level.isActive || !level.publicApplications) {
    return fail("That membership level is not open for applications.");
  }

  const existing = await openApplicationExists(organization.id);
  if (existing) {
    return fail(
      "You already have a membership request with WACA staff. They will be in touch before you send another.",
    );
  }

  await db.insert(membershipApplications).values({
    type: "level-change",
    status: "submitted",
    organizationId: organization.id,
    membershipId: membership.id,
    requestedLevelId: level.id,
    currentLevelId: membership.levelId,
    submittedByContactId: context.contactId,
    declaredRevenueBand: organization.revenueBand,
    applicantPayload: {
      source: "member-portal",
      requestedBy: context.data.contact.displayName,
      requestedAt: new Date().toISOString(),
      fromLevel: membership.level.name,
      toLevel: level.name,
      reason: parsed.data.reason,
    },
  });

  revalidatePath("/portal/membership");

  return ok(
    `Requested a move to ${level.name}. WACA staff will confirm eligibility against your revenue band and adjust your invoice — nothing changes until they approve it.`,
  );
}
