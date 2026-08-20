/**
 * A very small PDF writer.
 *
 * WACA needs to hand a member a printable invoice. That is the whole
 * requirement, so this is ~300 lines of layout and a hand-rolled xref table
 * rather than a 2 MB rendering dependency. Helvetica and Helvetica-Bold are
 * the two PDF base-14 fonts every reader already has, so nothing is embedded.
 *
 * Deliberately not supported: images, colour beyond greyscale, non-Latin text.
 * Anything outside printable ASCII is transliterated or dropped by clean().
 */

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN_X = 56;
const MARGIN_TOP = 62;
const MARGIN_BOTTOM = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;

/* ------------------------------------------------------------ font metrics */

// Widths in 1/1000 em for ASCII 32..126.
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
  500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584,
];

const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584,
  584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
  278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278,
  556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556,
  500, 389, 280, 389, 584,
];

/** Point width of `text` set in Helvetica (or the bold cut) at `size`. */
export function textWidth(text: string, size: number, bold = false): number {
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    total += table[code - 32] ?? 556;
  }
  return (total * size) / 1000;
}

const TRANSLITERATE: Record<string, string> = {
  "—": "-",
  "–": "-",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "…": "...",
  "•": "*",
  " ": " ",
  "−": "-",
};

/** Printable ASCII only. Everything else is transliterated or dropped. */
function clean(input: string): string {
  let out = "";
  for (const ch of String(input ?? "")) {
    const mapped = TRANSLITERATE[ch] ?? ch;
    for (const c of mapped) {
      const code = c.charCodeAt(0);
      out += code >= 32 && code <= 126 ? c : "";
    }
  }
  return out;
}

function escapePdf(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrap(text: string, size: number, bold: boolean, width: number): string[] {
  const words = clean(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, size, bold) <= width || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Trims a single line to fit, with an ellipsis. Used inside table cells. */
export function truncate(text: string, size: number, bold: boolean, width: number) {
  const value = clean(text);
  if (textWidth(value, size, bold) <= width) return value;
  let out = value;
  while (out.length > 1 && textWidth(`${out}...`, size, bold) > width) {
    out = out.slice(0, -1);
  }
  return `${out}...`;
}

/* ------------------------------------------------------------------ blocks */

export interface TableColumn {
  label: string;
  /** Fraction of the content width, 0-1. Must sum to <= 1. */
  width: number;
  align?: "left" | "right";
}

export type PdfBlock =
  | { kind: "eyebrow"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "subheading"; text: string }
  | { kind: "paragraph"; text: string; muted?: boolean }
  | { kind: "pairs"; pairs: [string, string][]; labelWidth?: number }
  | { kind: "table"; columns: TableColumn[]; rows: string[][] }
  | { kind: "totals"; rows: [string, string][]; emphasiseLast?: boolean }
  | { kind: "rule" }
  | { kind: "gap"; height: number };

export interface PdfDocumentSpec {
  title: string;
  author?: string;
  subject?: string;
  blocks: readonly PdfBlock[];
  /** Rendered small and grey at the foot of every page. */
  footer?: string;
}

/* ------------------------------------------------------------------ writer */

interface PageBuffer {
  ops: string[];
}

class Layout {
  pages: PageBuffer[] = [];
  private page!: PageBuffer;
  y = 0;

  constructor(private readonly footer?: string) {
    this.newPage();
  }

  newPage() {
    this.page = { ops: [] };
    this.pages.push(this.page);
    this.y = PAGE_HEIGHT - MARGIN_TOP;
    if (this.footer) {
      this.rawText(clean(this.footer), MARGIN_X, MARGIN_BOTTOM - 22, 7.5, false, 0.45);
    }
  }

  need(height: number) {
    if (this.y - height < MARGIN_BOTTOM) this.newPage();
  }

  rawText(text: string, x: number, y: number, size: number, bold: boolean, grey = 0.1) {
    if (!text) return;
    this.page.ops.push(
      `${grey.toFixed(2)} ${grey.toFixed(2)} ${grey.toFixed(2)} rg`,
      "BT",
      `/${bold ? "F2" : "F1"} ${size} Tf`,
      `${x.toFixed(2)} ${y.toFixed(2)} Td`,
      `(${escapePdf(text)}) Tj`,
      "ET",
    );
  }

  line(x1: number, y: number, x2: number, grey = 0.82) {
    this.page.ops.push(
      `${grey.toFixed(2)} ${grey.toFixed(2)} ${grey.toFixed(2)} RG`,
      "0.7 w",
      `${x1.toFixed(2)} ${y.toFixed(2)} m ${x2.toFixed(2)} ${y.toFixed(2)} l S`,
    );
  }

  /** Wrapped, left-aligned run of text. Advances y. */
  text(
    value: string,
    { size, bold = false, grey = 0.1, leading = size * 1.4, x = MARGIN_X, width = CONTENT_WIDTH }:
      { size: number; bold?: boolean; grey?: number; leading?: number; x?: number; width?: number },
  ) {
    for (const lineText of wrap(value, size, bold, width)) {
      this.need(leading);
      this.y -= leading;
      this.rawText(lineText, x, this.y, size, bold, grey);
    }
  }

  right(value: string, size: number, bold: boolean, baselineY: number, grey = 0.1) {
    const text = clean(value);
    const x = MARGIN_X + CONTENT_WIDTH - textWidth(text, size, bold);
    this.rawText(text, x, baselineY, size, bold, grey);
  }
}

function renderBlocks(layout: Layout, blocks: readonly PdfBlock[]) {
  for (const block of blocks) {
    switch (block.kind) {
      case "eyebrow": {
        layout.text(block.text.toUpperCase(), { size: 8, bold: true, grey: 0.4, leading: 12 });
        break;
      }
      case "heading": {
        layout.y -= 4;
        layout.text(block.text, { size: 17, bold: true, leading: 21 });
        break;
      }
      case "subheading": {
        layout.y -= 8;
        layout.text(block.text.toUpperCase(), { size: 8, bold: true, grey: 0.4, leading: 12 });
        break;
      }
      case "paragraph": {
        layout.y -= 2;
        layout.text(block.text, { size: 9.5, grey: block.muted ? 0.4 : 0.15, leading: 13.5 });
        break;
      }
      case "gap": {
        layout.need(block.height);
        layout.y -= block.height;
        break;
      }
      case "rule": {
        layout.need(12);
        layout.y -= 8;
        layout.line(MARGIN_X, layout.y, MARGIN_X + CONTENT_WIDTH);
        layout.y -= 4;
        break;
      }
      case "pairs": {
        const labelWidth = block.labelWidth ?? 132;
        for (const [label, value] of block.pairs) {
          const valueLines = wrap(value, 9.5, false, CONTENT_WIDTH - labelWidth);
          const height = Math.max(14, valueLines.length * 13);
          layout.need(height);
          const top = layout.y - 10;
          layout.rawText(clean(label), MARGIN_X, top, 8, true, 0.42);
          valueLines.forEach((lineText, i) => {
            layout.rawText(lineText, MARGIN_X + labelWidth, top - i * 13, 9.5, false, 0.1);
          });
          layout.y -= height;
        }
        break;
      }
      case "table": {
        const widths = block.columns.map((c) => c.width * CONTENT_WIDTH);
        const xs: number[] = [];
        let cursor = MARGIN_X;
        for (const w of widths) {
          xs.push(cursor);
          cursor += w;
        }

        const header = () => {
          layout.need(24);
          layout.y -= 12;
          block.columns.forEach((col, i) => {
            const label = clean(col.label.toUpperCase());
            const x =
              col.align === "right"
                ? xs[i] + widths[i] - textWidth(label, 7.5, true)
                : xs[i];
            layout.rawText(label, x, layout.y, 7.5, true, 0.42);
          });
          layout.y -= 5;
          layout.line(MARGIN_X, layout.y, MARGIN_X + CONTENT_WIDTH);
        };

        header();

        for (const row of block.rows) {
          const cellLines = row.map((cell, i) =>
            wrap(cell, 9, false, widths[i] - 8),
          );
          const rows = Math.max(...cellLines.map((l) => l.length), 1);
          const height = rows * 12 + 6;
          if (layout.y - height < MARGIN_BOTTOM) {
            layout.newPage();
            header();
          }
          const top = layout.y - 12;
          cellLines.forEach((lines, i) => {
            lines.forEach((lineText, j) => {
              const x =
                block.columns[i].align === "right"
                  ? xs[i] + widths[i] - textWidth(lineText, 9, false)
                  : xs[i];
              layout.rawText(lineText, x, top - j * 12, 9, false, 0.12);
            });
          });
          layout.y -= height;
          layout.line(MARGIN_X, layout.y + 2, MARGIN_X + CONTENT_WIDTH, 0.9);
        }
        break;
      }
      case "totals": {
        block.rows.forEach(([label, value], index) => {
          const last = index === block.rows.length - 1;
          const bold = Boolean(block.emphasiseLast && last);
          layout.need(16);
          layout.y -= 15;
          const baseline = layout.y;
          const valueText = clean(value);
          const valueWidth = textWidth(valueText, bold ? 10.5 : 9.5, bold);
          const right = MARGIN_X + CONTENT_WIDTH;
          layout.rawText(
            clean(label),
            right - valueWidth - 16 - textWidth(clean(label), bold ? 10.5 : 9.5, bold),
            baseline,
            bold ? 10.5 : 9.5,
            bold,
            bold ? 0.1 : 0.4,
          );
          layout.rawText(valueText, right - valueWidth, baseline, bold ? 10.5 : 9.5, bold, 0.1);
          if (bold) {
            layout.line(right - valueWidth - 150, baseline + 12, right, 0.7);
          }
        });
        break;
      }
    }
  }
}

/** Serialises the laid-out pages into a PDF file. */
export function buildPdf(spec: PdfDocumentSpec): Uint8Array {
  const layout = new Layout(spec.footer);
  renderBlocks(layout, spec.blocks);

  const pageCount = layout.pages.length;
  // 1 catalog, 2 pages, 3 F1, 4 F2, 5 info, then page + content pairs.
  const firstPageObj = 6;
  const objects: string[] = [];

  const kids = Array.from(
    { length: pageCount },
    (_, i) => `${firstPageObj + i * 2} 0 R`,
  ).join(" ");

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`;
  objects[3] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  objects[5] =
    `<< /Title (${escapePdf(clean(spec.title))}) ` +
    `/Author (${escapePdf(clean(spec.author ?? ""))}) ` +
    `/Subject (${escapePdf(clean(spec.subject ?? ""))}) ` +
    "/Producer (WACA Platform) >>";

  layout.pages.forEach((page, i) => {
    const pageObj = firstPageObj + i * 2;
    const contentObj = pageObj + 1;
    objects[pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObj} 0 R >>`;
    const stream = page.ops.join("\n");
    objects[contentObj] =
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });

  const total = objects.length; // objects[0] is a hole; length === maxIndex + 1
  let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];

  for (let i = 1; i < total; i++) {
    offsets[i] = Buffer.byteLength(out, "latin1");
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${total} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(out, "latin1"));
}
