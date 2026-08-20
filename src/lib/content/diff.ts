import { money } from "@/lib/finance/money";
import { isLongText, type EditorField, type FieldKind } from "./fields";

/**
 * ============================================================================
 *  A REAL DIFF, NOT A "CHANGED" BADGE.
 *
 *  Revision history is only worth keeping if somebody can see what changed
 *  without reading two versions side by side and trusting their eyes. Two
 *  shapes of change need two shapes of diff, so this module does both:
 *
 *    FIELD-LEVEL for structured data. Walk the collection's field definition,
 *      compare value by value, and report which named fields moved. A press
 *      item whose `topics` gained "banking" says exactly that.
 *
 *    LINE-LEVEL inside long text. A 900-word body that changed one sentence
 *      must not render as "Body: changed". Longest-common-subsequence over
 *      lines, which is what git shows and what an editor expects to see.
 *
 *  Nothing here touches the database and nothing here renders. It runs in the
 *  browser too, which is what lets the publish queue show a diff summary for
 *  twelve items without twelve round trips.
 * ============================================================================
 */

export type LineOp = "same" | "add" | "remove";

export interface DiffLine {
  op: LineOp;
  text: string;
  /** 1-based line number in the old text. Null on an added line. */
  beforeLine: number | null;
  /** 1-based line number in the new text. Null on a removed line. */
  afterLine: number | null;
}

/**
 * Beyond this many lines on either side the LCS table stops being free
 * (it is O(n*m) cells). A body that long is a document, not a page, and
 * "this field changed" is an honest answer for it.
 */
const MAX_DIFF_LINES = 1200;

/** Longest common subsequence over lines. */
export function diffLines(before: string, after: string): DiffLine[] | null {
  const a = (before ?? "").replace(/\r\n?/g, "\n").split("\n");
  const b = (after ?? "").replace(/\r\n?/g, "\n").split("\n");
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null;

  const n = a.length;
  const m = b.length;
  // table[i][j] = LCS length of a[i..] and b[j..]
  const table: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: "same", text: a[i], beforeLine: i + 1, afterLine: j + 1 });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ op: "remove", text: a[i], beforeLine: i + 1, afterLine: null });
      i += 1;
    } else {
      out.push({ op: "add", text: b[j], beforeLine: null, afterLine: j + 1 });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ op: "remove", text: a[i], beforeLine: i + 1, afterLine: null });
    i += 1;
  }
  while (j < m) {
    out.push({ op: "add", text: b[j], beforeLine: null, afterLine: j + 1 });
    j += 1;
  }
  return out;
}

/** Drop long runs of unchanged lines, keeping `context` either side. */
export function collapseUnchanged(
  lines: DiffLine[],
  context = 2,
): (DiffLine | { op: "gap"; skipped: number })[] {
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.op === "same") return;
    for (let k = index - context; k <= index + context; k += 1) {
      if (k >= 0 && k < lines.length) keep.add(k);
    }
  });

  const out: (DiffLine | { op: "gap"; skipped: number })[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      if (skipped) {
        out.push({ op: "gap", skipped });
        skipped = 0;
      }
      out.push(line);
    } else {
      skipped += 1;
    }
  });
  if (skipped) out.push({ op: "gap", skipped });
  return out;
}

/* ------------------------------------------------------------ scalars */

/** How a value reads in a diff column. */
export function renderValue(kind: FieldKind, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  switch (kind) {
    case "boolean":
      return value ? "Yes" : "No";
    case "money":
      return typeof value === "number" ? money(value) : String(value);
    case "multiselect":
    case "assetList":
      return Array.isArray(value) && value.length
        ? value.map(String).join(", ")
        : "—";
    case "repeater":
      return Array.isArray(value)
        ? `${value.length} item${value.length === 1 ? "" : "s"}`
        : "—";
    case "group":
      return JSON.stringify(value);
    default:
      return typeof value === "string" ? value : JSON.stringify(value);
  }
}

function stable(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return JSON.stringify(value.map(stableValue));
  return JSON.stringify(stableValue(value));
}

/** Key-sorted, so a re-serialised object with the same content compares equal. */
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([k, v]) => [k, stableValue(v)]));
  }
  return value;
}

/* -------------------------------------------------------- field diffs */

export type DiffStatus = "added" | "removed" | "changed" | "unchanged";

export interface FieldDiff {
  name: string;
  label: string;
  kind: FieldKind;
  status: DiffStatus;
  before: unknown;
  after: unknown;
  beforeText: string;
  afterText: string;
  /** Present for long-text fields that actually changed. */
  lines?: DiffLine[] | null;
  /** Repeaters: per-row diffs, so "row 2's label changed" is visible. */
  rows?: RowDiff[];
}

export interface RowDiff {
  index: number;
  status: DiffStatus;
  fields: FieldDiff[];
}

export interface RevisionSide {
  title: string;
  slug: string;
  excerpt: string | null;
  data: Record<string, unknown>;
}

/**
 * The identity columns are diffed too, and first. A revision that renamed the
 * page and changed nothing else is a real change, and one that changed the
 * slug is the single most consequential edit anybody can make here.
 */
const IDENTITY: EditorField[] = [
  identityField("title", "Title", "text"),
  identityField("slug", "Slug", "slug"),
  identityField("excerpt", "Summary", "longtext"),
];

function identityField(
  name: string,
  label: string,
  kind: FieldKind,
): EditorField {
  return {
    name,
    label,
    kind,
    required: false,
    options: [],
    fields: [],
    sidebar: false,
    altTextRequired: false,
    markdown: false,
    storedType: kind,
  };
}

function diffOne(
  field: EditorField,
  before: unknown,
  after: unknown,
): FieldDiff {
  const b = stable(before);
  const a = stable(after);

  let status: DiffStatus;
  if (b === a) status = "unchanged";
  else if (b === "") status = "added";
  else if (a === "") status = "removed";
  else status = "changed";

  const diff: FieldDiff = {
    name: field.name,
    label: field.label,
    kind: field.kind,
    status,
    before,
    after,
    beforeText: renderValue(field.kind, before),
    afterText: renderValue(field.kind, after),
  };

  if (status !== "unchanged" && isLongText(field)) {
    diff.lines = diffLines(
      typeof before === "string" ? before : "",
      typeof after === "string" ? after : "",
    );
  }

  if (field.kind === "repeater" && field.fields.length) {
    const rowsBefore = Array.isArray(before) ? before : [];
    const rowsAfter = Array.isArray(after) ? after : [];
    const count = Math.max(rowsBefore.length, rowsAfter.length);
    const rows: RowDiff[] = [];
    for (let index = 0; index < count; index += 1) {
      const rb = rowsBefore[index] as Record<string, unknown> | undefined;
      const ra = rowsAfter[index] as Record<string, unknown> | undefined;
      const rowStatus: DiffStatus = !rb
        ? "added"
        : !ra
          ? "removed"
          : stable(rb) === stable(ra)
            ? "unchanged"
            : "changed";
      rows.push({
        index,
        status: rowStatus,
        fields: field.fields.map((child) =>
          diffOne(child, rb?.[child.name], ra?.[child.name]),
        ),
      });
    }
    diff.rows = rows;
  }

  return diff;
}

/**
 * Diff two revisions of the same item.
 *
 * Keys present in the data but absent from the field definition are still
 * diffed, under a humanised name — a field removed from content_types must
 * not make the value it left behind invisible.
 */
export function diffRevisions(
  fields: EditorField[],
  before: RevisionSide | null,
  after: RevisionSide,
): FieldDiff[] {
  const beforeSide: RevisionSide =
    before ?? { title: "", slug: "", excerpt: null, data: {} };

  const identity = IDENTITY.map((field) =>
    diffOne(
      field,
      (beforeSide as unknown as Record<string, unknown>)[field.name],
      (after as unknown as Record<string, unknown>)[field.name],
    ),
  );

  const defined = fields.map((field) =>
    diffOne(field, beforeSide.data[field.name], after.data[field.name]),
  );

  const known = new Set(fields.map((f) => f.name));
  const orphanKeys = [
    ...new Set([
      ...Object.keys(beforeSide.data),
      ...Object.keys(after.data),
    ]),
  ].filter((k) => !known.has(k));

  const orphans = orphanKeys.map((key) =>
    diffOne(
      identityField(key, `${key} (not in this collection's fields)`, "text"),
      beforeSide.data[key],
      after.data[key],
    ),
  );

  return [...identity, ...defined, ...orphans];
}

export interface DiffSummary {
  changed: number;
  added: number;
  removed: number;
  labels: string[];
  /** "Headline, Body and 2 more" — the line the publish queue prints. */
  text: string;
}

export function summariseDiff(diffs: FieldDiff[]): DiffSummary {
  const moved = diffs.filter((d) => d.status !== "unchanged");
  const labels = moved.map((d) => d.label);
  const head = labels.slice(0, 3);
  const rest = labels.length - head.length;

  return {
    changed: moved.filter((d) => d.status === "changed").length,
    added: moved.filter((d) => d.status === "added").length,
    removed: moved.filter((d) => d.status === "removed").length,
    labels,
    text: !labels.length
      ? "No field changed."
      : rest > 0
        ? `${head.join(", ")} and ${rest} more`
        : head.join(", "),
  };
}
