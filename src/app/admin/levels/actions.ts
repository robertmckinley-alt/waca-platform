"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { membershipLevels } from "@/db/schema";
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

const updateLevelSchema = z.object({
  levelId: z.uuid(),
  name: z.string().trim().min(1, "Required").max(120),
  /** Entered in dollars; stored as integer cents. Never a float in the DB. */
  feeDollars: z.coerce
    .number()
    .min(0, "Cannot be negative")
    .max(1_000_000, "Too large"),
  billingPeriod: z.enum(["annual", "monthly", "lifetime"]),
  renewalAnchor: z.enum(["join_date", "calendar"]),
  renewalAnchorDay: z
    .string()
    .optional()
    .transform((v) => (v && v.length ? Number(v) : null))
    .refine((v) => v === null || (Number.isInteger(v) && v >= 1 && v <= 28), {
      message: "Use a day between 1 and 28",
    }),
  revenueBand: z
    .string()
    .optional()
    .transform((v) => (v && v.length ? v : null))
    .refine(
      (v) =>
        v === null ||
        [
          "over-5m",
          "1m-4.9m",
          "150k-1m",
          "under-1m",
          "under-150k",
          "not-disclosed",
        ].includes(v),
      { message: "Unknown revenue band" },
    ),
  description: z
    .string()
    .max(2000)
    .optional()
    .transform((v) => {
      const t = v?.trim();
      return t ? t : null;
    }),
  publicApplications: checkboxSchema,
  autoRenewDefault: checkboxSchema,
  isActive: checkboxSchema,
});

/**
 * Edits one membership level.
 *
 * `autoRenewDefault` is the lever this whole platform exists to pull: it is
 * off on every level inherited from Wild Apricot. Changing it here sets the
 * default for FUTURE memberships; existing rows keep their own override, which
 * is what the renewal screen's bulk toggle is for.
 */
export async function updateMembershipLevel(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();

  const parsed = updateLevelSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;

  const [existing] = await db
    .select()
    .from(membershipLevels)
    .where(eq(membershipLevels.id, input.levelId))
    .limit(1);
  if (!existing) return fail("That level no longer exists.");

  const next = {
    name: input.name,
    feeCents: Math.round(input.feeDollars * 100),
    billingPeriod: input.billingPeriod,
    renewalAnchor: input.renewalAnchor,
    renewalAnchorDay: input.renewalAnchorDay,
    revenueBand: input.revenueBand as typeof existing.revenueBand,
    description: input.description,
    publicApplications: input.publicApplications,
    autoRenewDefault: input.autoRenewDefault,
    isActive: input.isActive,
  };

  const diff = diffFields(
    existing as unknown as Record<string, unknown>,
    next as unknown as Record<string, unknown>,
  );
  if (!hasChanges(diff)) return ok("Nothing to save — no fields changed.");

  await db.transaction(async (tx) => {
    await tx
      .update(membershipLevels)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(membershipLevels.id, input.levelId));
    await recordAudit({
      db: tx,
      actor,
      action: "update",
      entity: "membership_levels",
      entityId: input.levelId,
      before: diff.before,
      after: diff.after,
    });
  });

  revalidatePath("/admin/levels");
  revalidatePath("/admin/members");
  return ok(`${input.name} saved.`);
}

const bulkDefaultSchema = z.object({
  autoRenewDefault: z.enum(["on", "off"]),
});

/**
 * Sets the auto-renew DEFAULT across every level in one move. Deliberately
 * separate from the per-level form because it is the single highest-impact
 * switch in the product, and it is audited as such.
 */
export async function setAllAutoRenewDefaults(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();

  const parsed = bulkDefaultSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const value = parsed.data.autoRenewDefault === "on";

  const changed = await db.transaction(async (tx) => {
    const before = await tx
      .select({
        id: membershipLevels.id,
        name: membershipLevels.name,
        autoRenewDefault: membershipLevels.autoRenewDefault,
      })
      .from(membershipLevels);

    const targets = before.filter((l) => l.autoRenewDefault !== value);
    if (targets.length === 0) return 0;

    await tx
      .update(membershipLevels)
      .set({ autoRenewDefault: value, updatedAt: new Date() });

    for (const level of targets) {
      await recordAudit({
        db: tx,
        actor,
        action: "update",
        entity: "membership_levels",
        entityId: level.id,
        before: { autoRenewDefault: level.autoRenewDefault },
        after: { autoRenewDefault: value },
        metadata: { bulk: "all-levels" },
      });
    }
    return targets.length;
  });

  revalidatePath("/admin/levels");
  revalidatePath("/admin/members");

  return changed === 0
    ? ok("Every level already had that default.")
    : ok(
        `Auto-renew default turned ${value ? "on" : "off"} for ${changed} level${changed === 1 ? "" : "s"}. Existing memberships keep their own setting.`,
      );
}
