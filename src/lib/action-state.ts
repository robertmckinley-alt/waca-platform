import { z } from "zod";

/**
 * The return shape of every admin server action. Actions never throw for
 * validation problems — they return a typed result the form renders inline.
 * They DO throw for authorisation failures, which are a bug or an attack, not
 * a user error.
 */
export interface ActionState {
  status: "idle" | "success" | "error";
  message?: string;
  fieldErrors?: Record<string, string[]>;
  /** Free-form payload, e.g. how many rows a bulk action touched. */
  data?: Record<string, unknown>;
}

export const IDLE_STATE: ActionState = { status: "idle" };

export function ok(message: string, data?: Record<string, unknown>): ActionState {
  return { status: "success", message, data };
}

export function fail(message: string): ActionState {
  return { status: "error", message };
}

/** Turns a Zod 4 failure into the inline field errors the form renders. */
export function invalid(error: z.ZodError): ActionState {
  const flat = z.flattenError(error);
  return {
    status: "error",
    message: "Fix the highlighted fields and try again.",
    fieldErrors: flat.fieldErrors as Record<string, string[]>,
  };
}

/** FormData -> plain object, collapsing repeated keys into arrays. */
export function formToObject(formData: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (value instanceof File) continue;
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
}

/** Reads every value for a repeated field (checkbox groups, bulk selection). */
export function formList(formData: FormData, key: string): string[] {
  return formData
    .getAll(key)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

/**
 * HTML checkboxes submit "on" when ticked and NOTHING when not, so the key is
 * absent from the FormData entirely.
 *
 * This must therefore be preprocess-based, not a union containing
 * z.undefined(): Zod 4 requires a key to be present unless the schema is
 * itself optional, so the union form rejected every unticked box with
 * "expected nonoptional, received undefined" — i.e. turning a checkbox OFF
 * could never be saved. preprocess runs before the presence check and maps a
 * missing key to `false`.
 */
export const checkboxSchema = z.preprocess(
  (v) => v === true || v === "on" || v === "true" || v === "1",
  z.boolean(),
);
