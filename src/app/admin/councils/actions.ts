"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { councilMembers, councils } from "@/db/schema";
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
import { applyAutoEnrolment } from "@/lib/councils/auto-enrol";

/**
 * ==========================================================================
 *  SECTOR COUNCIL ADMINISTRATION
 *
 *  requireStaff() -> Zod -> transaction -> audit_log -> revalidatePath, the
 *  same shape as every other admin action in this codebase.
 * ==========================================================================
 */

const LICENSE_TYPES = [
  "retail",
  "producer",
  "processor",
  "producer-processor",
  "lab",
  "transport",
  "none",
] as const;

const COUNCIL_ROLES = ["member", "chair", "vice-chair", "staff-liaison"] as const;

/* ------------------------------------------------------- update council */

const updateSchema = z.object({
  councilId: z.uuid(),
  name: z.string().trim().min(2, "Give the council a name").max(120),
  description: z
    .string()
    .max(2000)
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : null)),
  isActive: z
    .union([z.literal("on"), z.literal("")])
    .optional()
    .transform((v) => v === "on"),
});

export async function updateCouncil(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();

  const parsed = updateSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;

  const licenceTypes = formList(formData, "autoEnrollLicenseTypes").filter(
    (l): l is (typeof LICENSE_TYPES)[number] =>
      (LICENSE_TYPES as readonly string[]).includes(l),
  );

  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(councils)
      .where(eq(councils.id, input.councilId))
      .limit(1);
    if (!before) throw new Error("Council not found");

    const next = {
      name: input.name,
      description: input.description,
      isActive: input.isActive,
      autoEnrollLicenseTypes: licenceTypes as never,
      updatedAt: new Date(),
    };

    await tx.update(councils).set(next).where(eq(councils.id, input.councilId));

    const diff = diffFields(
      before as unknown as Record<string, unknown>,
      next as unknown as Record<string, unknown>,
    );
    if (hasChanges(diff)) {
      await recordAudit({
        db: tx,
        actor,
        action: "update",
        entity: "councils",
        entityId: input.councilId,
        before: diff.before,
        after: diff.after,
      });
    }
  });

  revalidatePath("/admin/councils");
  revalidatePath(`/admin/councils/${input.councilId}`);
  revalidatePath("/portal/councils");
  return ok("Saved.");
}

/* --------------------------------------------------- run auto-enrolment */

export async function runAutoEnrolment(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();

  const councilId = formData.get("councilId");
  if (typeof councilId !== "string" || !z.uuid().safeParse(councilId).success) {
    return fail("Missing council.");
  }

  const added = await db.transaction(async (tx) => {
    const n = await applyAutoEnrolment(councilId, { db: tx });
    if (n > 0) {
      await recordAudit({
        db: tx,
        actor,
        action: "create",
        entity: "council_members",
        entityId: councilId,
        after: { enrolled: n },
        metadata: { reason: "auto-enrolment-run" },
      });
    }
    return n;
  });

  revalidatePath("/admin/councils");
  revalidatePath(`/admin/councils/${councilId}`);

  return ok(
    added === 0
      ? "Already up to date — every qualifying contact is on the roster."
      : `Enrolled ${added} contact${added === 1 ? "" : "s"} from organisations holding a qualifying licence.`,
  );
}

/* --------------------------------------------------------- member roles */

const memberSchema = z.object({
  councilId: z.uuid(),
  contactId: z.uuid(),
  role: z.enum(COUNCIL_ROLES),
});

export async function updateCouncilMemberRole(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();

  const parsed = memberSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const { councilId, contactId, role } = parsed.data;

  await db.transaction(async (tx) => {
    await tx
      .update(councilMembers)
      .set({ role, updatedAt: new Date() })
      .where(
        and(
          eq(councilMembers.councilId, councilId),
          eq(councilMembers.contactId, contactId),
        ),
      );

    await recordAudit({
      db: tx,
      actor,
      action: "update",
      entity: "council_members",
      entityId: contactId,
      after: { role, councilId },
    });
  });

  revalidatePath(`/admin/councils/${councilId}`);
  return ok("Role updated.");
}

export async function removeCouncilMember(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();

  const councilId = formData.get("councilId");
  const contactId = formData.get("contactId");
  if (typeof councilId !== "string" || typeof contactId !== "string") {
    return fail("Missing council or contact.");
  }

  await db.transaction(async (tx) => {
    // Deactivated with a leftOn date rather than deleted: council service is
    // part of a member's record and the roster of who sat on what, when, is
    // what the annual policy meeting runs on.
    await tx
      .update(councilMembers)
      .set({
        isActive: false,
        leftOn: new Date().toISOString().slice(0, 10),
        // Re-running auto-enrolment must not immediately undo a deliberate
        // removal, so the row stops being the reconciler's business.
        autoEnrolled: false,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(councilMembers.councilId, councilId),
          eq(councilMembers.contactId, contactId),
        ),
      );

    await recordAudit({
      db: tx,
      actor,
      action: "update",
      entity: "council_members",
      entityId: contactId,
      after: { isActive: false, councilId },
      metadata: { reason: "removed-from-council" },
    });
  });

  revalidatePath(`/admin/councils/${councilId}`);
  return ok("Removed from the council.");
}
