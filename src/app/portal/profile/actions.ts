"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import { contacts } from "@/db/schema";
import { checkboxSchema, formToObject, invalid, ok, type ActionState } from "@/lib/action-state";
import {
  getMemberContactFields,
  mergeContactFieldValues,
} from "@/lib/portal/contact-fields";
import { requirePortal } from "@/lib/portal/session";

const profileSchema = z.object({
  firstName: z.string().trim().min(1, "Your first name is required").max(120),
  lastName: z.string().trim().min(1, "Your last name is required").max(120),
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
  mobile: z
    .preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? null : v),
      z.string().trim().max(40).nullable(),
    )
    .default(null),
  emailOptIn: checkboxSchema,
  directoryOptIn: checkboxSchema,
});

/**
 * Edits YOUR OWN contact record and nothing else.
 *
 * The row is pinned by `context.contactId`, which comes from the session — not
 * from the form. There is no contact id in the payload to tamper with.
 *
 * Email is deliberately absent: it is the sign-in identity, it is globally
 * unique, and changing it has to move the linked `users` row too. Members ask
 * staff, who do it in the admin with an audit trail.
 */
export async function updateProfileAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await requirePortal();

  const raw = formToObject(formData);
  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  // Re-read the field definitions; the submitted key set is not trusted.
  const definitions = await getMemberContactFields();
  const submittedFields: Record<string, unknown> = {};
  for (const field of definitions) {
    if (!field.editable) continue;
    const key = `cf_${field.key}`;
    if (field.type === "multiselect") {
      submittedFields[field.key] = formData.getAll(key).map(String);
    } else if (key in raw) {
      submittedFields[field.key] = raw[key];
    } else {
      submittedFields[field.key] = "";
    }
  }

  const contactFieldValues = mergeContactFieldValues(
    context.data.contact.contactFieldValues ?? {},
    submittedFields,
    definitions,
  );

  await db
    .update(contacts)
    .set({
      firstName: parsed.data.firstName,
      lastName: parsed.data.lastName,
      title: parsed.data.title,
      phone: parsed.data.phone,
      mobile: parsed.data.mobile,
      emailOptIn: parsed.data.emailOptIn,
      directoryOptIn: parsed.data.directoryOptIn,
      contactFieldValues,
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, context.contactId));

  revalidatePath("/portal/profile");
  revalidatePath("/portal");

  return ok("Saved. Your details are updated across WACA's records.");
}
