import { and, asc, eq, isNull } from "drizzle-orm";

import { db } from "@/db";
import { contactFields } from "@/db/schema";

export interface MemberEditableField {
  key: string;
  label: string;
  type: string;
  options: { value: string; label: string }[];
  helpText: string | null;
  required: boolean;
  editable: boolean;
}

/**
 * The Wild-Apricot-style custom fields a member may see or change on their own
 * record. Always read from the database — a form posting a key that is not
 * `memberEditable` must not be able to write it, so the action re-reads this
 * list rather than trusting the submitted field names.
 */
export async function getMemberContactFields(): Promise<MemberEditableField[]> {
  const rows = await db
    .select()
    .from(contactFields)
    .where(
      and(
        eq(contactFields.appliesTo, "contact"),
        eq(contactFields.memberVisible, true),
        isNull(contactFields.archivedAt),
      ),
    )
    .orderBy(asc(contactFields.sortOrder));

  return rows.map((row) => ({
    key: row.key,
    label: row.label,
    type: row.type,
    options: row.options ?? [],
    helpText: row.helpText,
    required: row.required,
    editable: row.memberEditable,
  }));
}

/**
 * Merges submitted values into the stored jsonb, accepting ONLY keys that are
 * member-editable. Unknown or read-only keys are dropped silently — they were
 * not offered by the form and are not the member's to set.
 */
export function mergeContactFieldValues(
  current: Record<string, unknown>,
  submitted: Record<string, unknown>,
  definitions: MemberEditableField[],
): Record<string, unknown> {
  const next = { ...current };

  for (const field of definitions) {
    if (!field.editable) continue;
    if (!(field.key in submitted)) continue;

    const raw = submitted[field.key];

    if (field.type === "multiselect") {
      const values = (Array.isArray(raw) ? raw : raw == null ? [] : [raw])
        .map(String)
        .filter((v) => field.options.some((o) => o.value === v));
      next[field.key] = values;
      continue;
    }

    if (field.type === "select") {
      const value = typeof raw === "string" ? raw : "";
      next[field.key] = field.options.some((o) => o.value === value) ? value : null;
      continue;
    }

    if (field.type === "number") {
      const value = typeof raw === "string" ? raw.trim() : "";
      const parsed = value === "" ? null : Number(value);
      next[field.key] =
        parsed === null || !Number.isFinite(parsed) ? null : Math.trunc(parsed);
      continue;
    }

    if (field.type === "boolean") {
      next[field.key] = raw === "on" || raw === "true" || raw === true;
      continue;
    }

    const value = typeof raw === "string" ? raw.trim() : "";
    next[field.key] = value === "" ? null : value.slice(0, 500);
  }

  return next;
}
