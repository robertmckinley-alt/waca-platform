import type { ContentFieldDef } from "@/db/queries";

/**
 * ============================================================================
 *  THE FIELD KINDS.
 *
 *  content_types.fields is jsonb. The editor walks it and renders a control
 *  per entry, which is what makes "add a field to the press collection" a row
 *  update rather than a React component and a deploy.
 *
 *  This module is the ONE place that decides what a stored field definition
 *  means. Nothing else in the CMS may branch on `def.type`: it asks
 *  normalizeFields() for EditorField[] and switches on `kind`.
 *
 *  Why a normalisation layer at all, rather than switching on the stored
 *  string directly:
 *
 *   · The stored vocabulary is a Drizzle `$type` on a jsonb column, so it is
 *     a *documentation* union, not a constraint. Real rows can and do carry
 *     keys the TypeScript interface never named (`refType`, `accept`,
 *     `multiple`). Reading them defensively here is the difference between
 *     "add a reference field by inserting a row" and "add a reference field
 *     by editing schema/content.ts and redeploying".
 *   · Two stored types collapse onto one control with a flag —
 *     `textarea` and `markdown` are both a long-text box, and the only
 *     difference is whether the preview pane parses Markdown. Keeping that a
 *     boolean on one kind means the preview pane exists once.
 *   · `slug` is a COLUMN, not a data key. The editor still has to render a
 *     control for it, with uniqueness and the published-slug warning, so it
 *     needs to be a kind even though no content_types row will ever name it.
 * ============================================================================
 */

export const FIELD_KINDS = [
  "text",
  "slug",
  "longtext",
  "richtext",
  "date",
  "datetime",
  "number",
  "money",
  "boolean",
  "select",
  "multiselect",
  "reference",
  "asset",
  "assetList",
  "url",
  "email",
  "repeater",
  "group",
] as const;

export type FieldKind = (typeof FIELD_KINDS)[number];

/** One-line description of each kind, rendered in the CMS field reference. */
export const FIELD_KIND_NOTES: Record<FieldKind, string> = {
  text: "A single line.",
  slug: "The URL segment. Lower-case words separated by single hyphens, unique within the collection. Changing a published slug breaks the live URL and the editor says so.",
  longtext:
    "A long text box. With `markdown: true` it renders a live preview pane beside the box.",
  richtext:
    "A constrained HTML fragment. The preview pane renders the same subset the site's templates allow.",
  date: "A calendar date, no time. Stored as yyyy-mm-dd.",
  datetime: "An instant. Stored as an ISO 8601 string in UTC.",
  number: "A number. `min` and `max` bound it.",
  money:
    "Money. Typed in dollars, stored as integer cents, formatted by the one currency formatter in @/lib/finance/money.",
  boolean: "A checkbox. Absent and false are the same thing.",
  select: "One value from `options`.",
  multiselect: "Zero or more values from `options`.",
  reference:
    "A pointer to another content item. `refType` names the collection; the control lists that collection's items and stores the target's slug.",
  asset:
    "One file from the media library. `accept` narrows it (e.g. \"image/\"). On an image field with `altTextRequired`, an asset with no alt text cannot be chosen.",
  assetList: "An ordered list of files from the media library.",
  url: "An absolute URL, or a site-relative path beginning with /.",
  email: "An email address.",
  repeater:
    "An ordered list of sub-objects, each shaped by the field's own `fields`. Add, remove and reorder.",
  group: "A single sub-object shaped by the field's own `fields`.",
};

/**
 * How a stored `content_types.fields[].type` maps onto a kind.
 *
 * Left column: what is in the database today (and what the ContentFieldDef
 * interface names). Right column: the control the editor renders.
 */
const STORED_TYPE_TO_KIND: Record<string, FieldKind> = {
  text: "text",
  slug: "slug",
  textarea: "longtext",
  markdown: "longtext",
  longtext: "longtext",
  richtext: "richtext",
  html: "richtext",
  number: "number",
  money: "money",
  boolean: "boolean",
  date: "date",
  datetime: "datetime",
  select: "select",
  multiselect: "multiselect",
  reference: "reference",
  ref: "reference",
  url: "url",
  email: "email",
  image: "asset",
  asset: "asset",
  file: "asset",
  assetList: "assetList",
  "asset-list": "assetList",
  gallery: "assetList",
  array: "repeater",
  repeater: "repeater",
  object: "group",
  group: "group",
};

/** Stored types that mean "parse this as Markdown in the preview pane". */
const MARKDOWN_TYPES = new Set(["markdown", "longtext"]);

/** Stored types that only ever hold an image. */
const IMAGE_TYPES = new Set(["image"]);

export interface FieldOption {
  value: string;
  label: string;
}

export interface EditorField {
  name: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  help?: string;
  placeholder?: string;
  options: FieldOption[];
  /** Children of a repeater or a group. Empty otherwise. */
  fields: EditorField[];
  min?: number;
  max?: number;
  pattern?: string;
  /** Render in the right-hand column rather than the main one. */
  sidebar: boolean;
  /** Image fields: refuse an asset that carries no alt text. */
  altTextRequired: boolean;
  /** longtext only: render the Markdown preview pane. */
  markdown: boolean;
  /** asset / assetList: mime prefix filter, e.g. "image/". */
  accept?: string;
  /** reference only: which collection the target lives in. */
  refType?: string;
  /** The verbatim `type` string from the database, for the field reference. */
  storedType: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function options(v: unknown): FieldOption[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((o) => {
    if (typeof o === "string") return [{ value: o, label: o }];
    if (o && typeof o === "object") {
      const value = str((o as Record<string, unknown>).value);
      if (!value) return [];
      return [
        { value, label: str((o as Record<string, unknown>).label) ?? value },
      ];
    }
    return [];
  });
}

/**
 * Read one stored definition into the shape the editor renders.
 *
 * Deliberately total: an unrecognised `type` becomes a plain text box rather
 * than throwing. A typo in a seed row should degrade to an editable field, not
 * take the whole CMS down — the field reference on /admin/content shows which
 * kind each field resolved to, so the typo is visible without being fatal.
 */
export function normalizeField(raw: unknown): EditorField | null {
  if (!raw || typeof raw !== "object") return null;
  const def = raw as Record<string, unknown>;
  const name = str(def.name);
  if (!name) return null;

  const storedType = str(def.type) ?? "text";
  const kind = STORED_TYPE_TO_KIND[storedType] ?? "text";

  const children =
    kind === "repeater" || kind === "group"
      ? normalizeFields(def.fields)
      : [];

  const accept =
    str(def.accept) ?? (IMAGE_TYPES.has(storedType) ? "image/" : undefined);

  return {
    name,
    label: str(def.label) ?? name,
    kind,
    required: def.required === true,
    help: str(def.help),
    placeholder: str(def.placeholder),
    options: options(def.options),
    fields: children,
    min: num(def.min),
    max: num(def.max),
    pattern: str(def.pattern),
    sidebar: def.sidebar === true,
    altTextRequired:
      def.altTextRequired === true || IMAGE_TYPES.has(storedType),
    markdown: MARKDOWN_TYPES.has(storedType),
    accept,
    refType: str(def.refType) ?? str(def.collection),
    storedType,
  };
}

export function normalizeFields(raw: unknown): EditorField[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeField)
    .filter((f): f is EditorField => f !== null);
}

/** Convenience for the common call: a ContentTypeRow's `fields`. */
export function editorFields(defs: ContentFieldDef[] | null | undefined): EditorField[] {
  return normalizeFields(defs ?? []);
}

/** The value a brand-new item starts a field at. */
export function emptyValue(field: EditorField): unknown {
  switch (field.kind) {
    case "boolean":
      return false;
    case "multiselect":
    case "assetList":
    case "repeater":
      return [];
    case "group":
      return {};
    case "number":
    case "money":
      return null;
    default:
      return "";
  }
}

/** A blank row for a repeater, shaped by the repeater's own children. */
export function emptyRow(field: EditorField): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const child of field.fields) out[child.name] = emptyValue(child);
  return out;
}

/**
 * True when the value counts as "the editor left this blank".
 *
 * `false` is NOT blank — an unticked "Consents to a public listing" is an
 * answer, and treating it as missing would let a required boolean pass by
 * being false, which is exactly backwards for a consent flag.
 */
export function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Fields that hold long prose, and so get a line-level diff in history. */
export function isLongText(field: EditorField): boolean {
  return field.kind === "longtext" || field.kind === "richtext";
}

export function fieldByName(
  fields: EditorField[],
  name: string,
): EditorField | undefined {
  return fields.find((f) => f.name === name);
}

/**
 * Slugs come from @/lib/slug — THE slugifier. Re-exported here because the
 * editor imports its field helpers from one place, not because there is a
 * second implementation. There is not.
 */
export { slugify, SLUG_PATTERN } from "@/lib/slug";

/**
 * Every media-library key an item's data points at, including inside
 * repeaters and groups. The publish gate needs this to check alt text on
 * exactly the assets that will end up on the page.
 */
export function collectAssetKeys(
  fields: EditorField[],
  data: Record<string, unknown> | null | undefined,
): string[] {
  const out: string[] = [];
  if (!data) return out;

  const walk = (defs: EditorField[], value: Record<string, unknown>) => {
    for (const field of defs) {
      const raw = value[field.name];
      if (field.kind === "asset") {
        if (typeof raw === "string" && raw.trim()) out.push(raw.trim());
      } else if (field.kind === "assetList") {
        if (Array.isArray(raw)) {
          for (const entry of raw) {
            if (typeof entry === "string" && entry.trim()) out.push(entry.trim());
          }
        }
      } else if (field.kind === "repeater" && Array.isArray(raw)) {
        for (const row of raw) {
          if (row && typeof row === "object") {
            walk(field.fields, row as Record<string, unknown>);
          }
        }
      } else if (field.kind === "group" && raw && typeof raw === "object") {
        walk(field.fields, raw as Record<string, unknown>);
      }
    }
  };

  walk(fields, data);
  return [...new Set(out)];
}
