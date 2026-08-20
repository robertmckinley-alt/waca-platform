import { z } from "zod";
import type { ContentTypeKey } from "@/db/queries";
import {
  isBlank,
  type EditorField,
} from "./fields";
import {
  buildValidationInput,
  SITE_SCHEMAS,
  SITE_TARGETS,
  TITLE_KEY,
  type ValidationSubject,
} from "./site-schemas";
import { headlineNamesSomethingSpecific } from "./rules";

/**
 * ============================================================================
 *  ONE VALIDATOR, RUN IN THREE PLACES.
 *
 *  · In the editor, as you type — so a problem is a red note under the field
 *    that caused it.
 *  · On the publish queue — so an item that would break the build is listed
 *    with the reason and cannot be ticked.
 *  · In the publish server action — because the queue is a form and a form is
 *    a POST endpoint, and the checkbox being disabled in the browser proves
 *    nothing about what arrives on the server.
 *
 *  It runs in the browser and on the server unchanged: nothing here imports
 *  the database, `next/*`, or node built-ins.
 *
 *  ERRORS BLOCK PUBLISH. WARNINGS NEVER DO. A validator that blocks on a
 *  judgement call is a validator staff learn to work around, and the day it
 *  blocks on something real they will work around that too.
 * ============================================================================
 */

export interface ContentIssue {
  /** Dotted path into the payload, e.g. "documents.0.label". */
  path: string;
  /** Top-level field name, for anchoring the message under a control. */
  field: string | null;
  label: string;
  message: string;
  /** The editorial rule this came from, when it came from one. */
  rule?: string;
}

export interface ValidationReport {
  ok: boolean;
  errors: ContentIssue[];
  warnings: ContentIssue[];
}

export const EMPTY_REPORT: ValidationReport = {
  ok: true,
  errors: [],
  warnings: [],
};

/** What the media library knows about one asset, keyed by its storage key. */
export interface AssetIndexEntry {
  key: string;
  filename: string;
  mime: string;
  altText: string | null;
  isDecorative: boolean;
}

export interface ValidateContentInput extends ValidationSubject {
  fields: EditorField[];
  /** Media-library rows, keyed by `key`. Omit to skip the alt-text check. */
  assets?: Record<string, AssetIndexEntry>;
}

/* --------------------------------------------------------------- labels */

/** "Board office", not "boardOffice". */
function humaniseKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Resolve a Zod path to the label the editor shows.
 *
 * Walks repeaters: `documents.0.label` resolves through the Documents
 * repeater's own children to "Documents 1 · Label", which is the only form of
 * the message that tells a staffer which row to look at.
 */
function labelForPath(
  fields: EditorField[],
  path: readonly PropertyKey[],
  type: ContentTypeKey,
): { label: string; field: string | null } {
  if (path.length === 0) return { label: "This item", field: null };

  const head = String(path[0]);

  if (head === "slug") return { label: "Slug", field: "slug" };
  if (head === "order") return { label: "Order", field: "sortOrder" };

  let current: EditorField | undefined = fields.find((f) => f.name === head);
  if (!current) {
    // A key the field definition does not describe. It still fails the site's
    // schema, so it still has to be reportable.
    return { label: humaniseKey(head), field: head };
  }

  const parts: string[] = [current.label];
  for (let i = 1; i < path.length; i += 1) {
    const seg = path[i];
    if (typeof seg === "number" || /^\d+$/.test(String(seg))) {
      parts[parts.length - 1] = `${parts[parts.length - 1]} ${Number(seg) + 1}`;
      continue;
    }
    const child: EditorField | undefined = current?.fields.find(
      (f) => f.name === String(seg),
    );
    parts.push(child ? child.label : humaniseKey(String(seg)));
    current = child;
  }

  // press stores its headline in `data.headline` but shows it as the item's
  // title too; naming the field the staffer can see beats naming the key.
  if (TITLE_KEY[type] === head && parts.length === 1) {
    return { label: parts[0], field: head };
  }
  return { label: parts.join(" · "), field: head };
}

/* --------------------------------------------------------- zod -> English */

function plainEnglish(issue: z.core.$ZodIssue, label: string): string {
  switch (issue.code) {
    case "invalid_type": {
      const received = (issue as { input?: unknown }).input;
      if (received === undefined || received === null) {
        return `${label} is required.`;
      }
      return `${label} must be ${article(String(issue.expected))}.`;
    }
    case "too_small": {
      const min = Number(issue.minimum);
      if (issue.origin === "string" && min <= 1) return `${label} is required.`;
      if (issue.origin === "array") {
        return `${label} needs at least ${min} item${min === 1 ? "" : "s"}.`;
      }
      return `${label} must be at least ${min}.`;
    }
    case "too_big": {
      const max = Number(issue.maximum);
      if (issue.origin === "string") {
        return `${label} is too long — ${max} characters at most.`;
      }
      if (issue.origin === "array") {
        return `${label} takes at most ${max} item${max === 1 ? "" : "s"}.`;
      }
      return `${label} must be ${max} or less.`;
    }
    case "invalid_value": {
      const values = (issue as { values?: readonly unknown[] }).values ?? [];
      if (values.length) {
        return `${label} must be one of: ${values.join(", ")}.`;
      }
      return `${label} is not one of the values the site accepts.`;
    }
    case "invalid_format": {
      // A regex/format rule with a hand-written message keeps its own words.
      if (issue.message && !/^Invalid/.test(issue.message)) return issue.message;
      return `${label} is not in the right format.`;
    }
    case "custom":
      return issue.message;
    default:
      return issue.message || `${label} is not valid.`;
  }
}

function article(expected: string): string {
  return /^[aeiou]/i.test(expected) ? `an ${expected}` : `a ${expected}`;
}

/* ------------------------------------------------------------ the check */

export function validateContent(
  input: ValidateContentInput,
): ValidationReport {
  const errors: ContentIssue[] = [];
  const warnings: ContentIssue[] = [];

  /* 1. Required fields, from the collection's own field definition.
   *    Done first and separately from the site schema, because the field
   *    definition is what the editor rendered and "Outlet is required" under
   *    the Outlet box is a better message than anything Zod produces about a
   *    key it did not find. */
  for (const field of input.fields) {
    if (!field.required) continue;
    const value = input.data[field.name];
    if (field.kind === "boolean") {
      // Required boolean = "you must answer", and false IS an answer.
      if (value === undefined || value === null) {
        errors.push({
          path: field.name,
          field: field.name,
          label: field.label,
          message: `${field.label} needs an answer.`,
        });
      }
      continue;
    }
    if (isBlank(value)) {
      errors.push({
        path: field.name,
        field: field.name,
        label: field.label,
        message: `${field.label} is required.`,
      });
    }
  }

  /* 2. The site's own schema. This is the gate that matters: anything it
   *    rejects would fail `astro build` at deploy time. */
  const schema = SITE_SCHEMAS[input.type];
  if (schema) {
    const merged = buildValidationInput(input);
    const result = schema.safeParse(merged);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const { label, field } = labelForPath(
          input.fields,
          issue.path,
          input.type,
        );
        const message = plainEnglish(issue, label);
        const path = issue.path.map(String).join(".") || "(item)";
        // Do not say the same thing twice: step 1 may already have reported
        // this exact field as missing.
        if (
          errors.some(
            (e) => e.field === field && e.message.endsWith("is required."),
          ) &&
          message.endsWith("is required.")
        ) {
          continue;
        }
        errors.push({ path, field, label, message });
      }
    }
  }

  /* 3. Alt text on referenced images.
   *
   *    THE RULE, and the reason it is not "every asset field must resolve to
   *    a library row": an IMAGE has to come from the media library, because
   *    that is the only place alt text lives and content_assets carries the
   *    CHECK that guarantees it. Any other asset — a PDF in public/docs, an
   *    mp3, a file inherited from the Wild Apricot corpus — may legitimately
   *    be a site-relative path, and refusing those would make the CMS unable
   *    to describe the site it is supposed to be editing.
   *
   *    Walks repeaters and groups: an image nested inside an agenda's
   *    documents list is on the same public page as one at the top level.
   */
  if (input.assets) {
    const assets = input.assets;
    const walk = (
      defs: EditorField[],
      values: Record<string, unknown>,
      prefix: string,
      labelPrefix: string,
    ) => {
      for (const field of defs) {
        const raw = values[field.name];
        const path = prefix ? `${prefix}.${field.name}` : field.name;

        if (field.kind === "repeater" && Array.isArray(raw)) {
          raw.forEach((row, index) => {
            if (row && typeof row === "object") {
              walk(
                field.fields,
                row as Record<string, unknown>,
                `${path}.${index}`,
                `${labelPrefix}${field.label} ${index + 1} · `,
              );
            }
          });
          continue;
        }
        if (field.kind === "group" && raw && typeof raw === "object") {
          walk(
            field.fields,
            raw as Record<string, unknown>,
            path,
            `${labelPrefix}${field.label} · `,
          );
          continue;
        }
        if (field.kind !== "asset" && field.kind !== "assetList") continue;
        // Only image fields are held to the library. See the note above.
        if (!field.altTextRequired) continue;

        const keys = (
          field.kind === "assetList" ? (Array.isArray(raw) ? raw : []) : [raw]
        ).filter((v): v is string => typeof v === "string" && v.trim() !== "");

        keys.forEach((key, index) => {
          const asset = assets[key];
          const where =
            `${labelPrefix}${field.label}` +
            (field.kind === "assetList" ? ` ${index + 1}` : "");

          if (!asset) {
            errors.push({
              path,
              field: prefix ? prefix.split(".")[0] : field.name,
              label: where,
              rule: "alt-text",
              message:
                `${where} points at a file that is not in the media library, ` +
                `so nothing here can vouch for its alt text. Choose it from ` +
                `the library, or clear the field.`,
            });
            return;
          }
          if (!asset.mime.startsWith("image/")) return;

          if (asset.isDecorative) {
            errors.push({
              path,
              field: prefix ? prefix.split(".")[0] : field.name,
              label: where,
              rule: "alt-text",
              message:
                `${where} is a decorative image, which renders as alt="". ` +
                `This field is content, so the image needs a description. ` +
                `Pick another file, or describe this one in the media library.`,
            });
            return;
          }
          if (!asset.altText?.trim()) {
            errors.push({
              path,
              field: prefix ? prefix.split(".")[0] : field.name,
              label: where,
              rule: "alt-text",
              message:
                `${where} has no alt text. Add it in the media library — ` +
                `every image on the public site is described or explicitly ` +
                `decorative.`,
            });
          }
        });
      }
    };

    walk(input.fields, input.data, "", "");
  }

  /* 4. Advisories. None of these block anything. */
  const titleKey = TITLE_KEY[input.type];
  if (
    (input.type === "press" || input.type === "post") &&
    titleKey
  ) {
    const headline =
      (typeof input.data[titleKey] === "string"
        ? (input.data[titleKey] as string)
        : "") || input.title;
    if (headline && !headlineNamesSomethingSpecific(headline)) {
      warnings.push({
        path: titleKey,
        field: titleKey,
        label: "Headline",
        rule: input.type === "press" ? "press-headline" : "post-headline",
        message:
          "This headline names no number, bill or date. House style asks for " +
          "one — “WACA opposes 37% excise increase in HB 2022”, not “WACA " +
          "responds to proposal”. Publishing is not blocked.",
      });
    }
  }

  if (!input.excerpt?.trim() && SITE_TARGETS[input.type].startsWith("src/content")) {
    warnings.push({
      path: "excerpt",
      field: "excerpt",
      label: "Summary",
      message:
        "No summary. This is what the collection's index card and the search " +
        "result show; without it the site falls back to the first line of the " +
        "body, which is rarely the sentence you would have chosen.",
    });
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** One line for the publish queue: why this item cannot go. */
export function blockerSummary(report: ValidationReport): string | null {
  if (report.ok) return null;
  const [first, ...rest] = report.errors;
  if (!rest.length) return first.message;
  return `${first.message} (and ${rest.length} more)`;
}
