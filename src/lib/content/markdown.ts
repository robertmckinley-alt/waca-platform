/**
 * ============================================================================
 *  MARKDOWN AND RICH TEXT -> A DATA STRUCTURE. NEVER -> AN HTML STRING.
 *
 *  The editor's preview pane shows a staffer what they are writing. It could
 *  have been four lines of regex and `dangerouslySetInnerHTML`, and that is
 *  exactly why it is not: the preview renders content that will shortly be on
 *  a public site, some of it pasted from email and PDFs, and an admin session
 *  is the most valuable session in the application.
 *
 *  These parsers emit blocks and inline runs. The React components in
 *  @/components/content/prose turn those into elements. There is no point in
 *  the pipeline where a string of markup is handed to the DOM, so there is no
 *  sanitiser to get wrong and nothing to keep up to date.
 *
 *  This is a PREVIEW renderer, not the site's renderer — Astro builds the
 *  real pages with its own Markdown pipeline. It covers the constructs WACA
 *  staff actually use (headings, emphasis, links, lists, quotes, rules, code)
 *  and renders anything else as the literal text it is, which is the honest
 *  failure mode for a preview.
 * ============================================================================
 */

export type MdInline =
  | { t: "text"; v: string }
  | { t: "strong"; v: string }
  | { t: "em"; v: string }
  | { t: "code"; v: string }
  | { t: "link"; v: string; href: string };

export type MdBlock =
  | { kind: "heading"; level: 2 | 3 | 4 | 5 | 6; inline: MdInline[] }
  | { kind: "paragraph"; inline: MdInline[] }
  | { kind: "list"; ordered: boolean; items: MdInline[][] }
  | { kind: "quote"; inline: MdInline[] }
  | { kind: "code"; text: string }
  | { kind: "rule" };

/* --------------------------------------------------------------- inline */

const INLINE = [
  { t: "code" as const, re: /`([^`]+)`/ },
  { t: "strong" as const, re: /\*\*([^*]+)\*\*/ },
  { t: "em" as const, re: /(?<!\*)\*([^*]+)\*(?!\*)/ },
  { t: "em" as const, re: /_([^_]+)_/ },
];

const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/;

export function parseInline(src: string): MdInline[] {
  if (!src) return [];
  const out: MdInline[] = [];
  let rest = src;

  while (rest.length) {
    // Find the earliest match of any inline construct.
    let bestIndex = -1;
    let best: { node: MdInline; length: number } | null = null;

    const link = LINK.exec(rest);
    if (link) {
      bestIndex = link.index;
      best = {
        node: { t: "link", v: link[1], href: link[2] },
        length: link[0].length,
      };
    }
    for (const rule of INLINE) {
      const m = rule.re.exec(rest);
      if (!m) continue;
      if (bestIndex === -1 || m.index < bestIndex) {
        bestIndex = m.index;
        best = { node: { t: rule.t, v: m[1] }, length: m[0].length };
      }
    }

    if (!best || bestIndex === -1) {
      out.push({ t: "text", v: rest });
      break;
    }
    if (bestIndex > 0) out.push({ t: "text", v: rest.slice(0, bestIndex) });
    out.push(best.node);
    rest = rest.slice(bestIndex + best.length);
  }

  return out.filter((n) => n.t !== "text" || n.v !== "");
}

/** Flatten back to plain text — used by the diff and by excerpt suggestions. */
export function inlineToText(nodes: MdInline[]): string {
  return nodes.map((n) => n.v).join("");
}

/* --------------------------------------------------------------- blocks */

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^\s*```/;

export function parseMarkdown(source: string): MdBlock[] {
  const lines = (source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];

  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ kind: "paragraph", inline: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push({
      kind: "list",
      ordered: list.ordered,
      items: list.items.map(parseInline),
    });
    list = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    blocks.push({ kind: "quote", inline: parseInline(quote.join(" ")) });
    quote = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (FENCE.test(line)) {
      flushAll();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      flushAll();
      continue;
    }

    if (RULE.test(line)) {
      flushAll();
      blocks.push({ kind: "rule" });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushAll();
      // H1 is the page title, rendered by the template. A heading typed at the
      // top of a body would give the page two h1s, which axe flags and a
      // screen-reader user hears as two documents; demote it.
      const level = Math.min(6, Math.max(2, heading[1].length)) as
        | 2
        | 3
        | 4
        | 5
        | 6;
      blocks.push({ kind: "heading", level, inline: parseInline(heading[2]) });
      continue;
    }

    const q = QUOTE.exec(line);
    if (q) {
      flushParagraph();
      flushList();
      quote.push(q[1]);
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      flushQuote();
      const isOrdered = Boolean(ordered);
      const textPart = (bullet ?? ordered)![1];
      if (!list || list.ordered !== isOrdered) {
        flushList();
        list = { ordered: isOrdered, items: [] };
      }
      list.items.push(textPart);
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line.trim());
  }

  flushAll();
  return blocks;
}

/* ------------------------------------------------------------- richtext */

/**
 * The tag allowlist for `richtext` fields. Anything outside it is rendered as
 * the literal text of the tag, so a pasted `<script>` shows up in the preview
 * as visible characters rather than disappearing (or running).
 */
export const RICHTEXT_TAGS = [
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "a",
  "ul",
  "ol",
  "li",
  "h2",
  "h3",
  "h4",
  "blockquote",
  "code",
] as const;

const TAG = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * Convert a constrained HTML fragment to the same block structure Markdown
 * produces, so the preview pane and the diff have one renderer.
 *
 * Deliberately crude: it maps the allowlisted block tags and turns everything
 * else into text. A richtext field is for a paragraph with a link in it, not
 * for a layout.
 */
export function parseRichText(source: string): MdBlock[] {
  const src = source ?? "";
  if (!src.trim()) return [];

  // Normalise the block tags into Markdown, then reuse the Markdown parser.
  let md = src
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*p\s*>/gi, "\n\n")
    .replace(/<\s*p\b[^>]*>/gi, "")
    .replace(/<\s*h2\b[^>]*>/gi, "\n\n## ")
    .replace(/<\s*h3\b[^>]*>/gi, "\n\n### ")
    .replace(/<\s*h4\b[^>]*>/gi, "\n\n#### ")
    .replace(/<\s*\/\s*h[234]\s*>/gi, "\n\n")
    .replace(/<\s*li\b[^>]*>/gi, "\n- ")
    .replace(/<\s*\/\s*li\s*>/gi, "")
    .replace(/<\s*\/?\s*(ul|ol)\b[^>]*>/gi, "\n\n")
    .replace(/<\s*blockquote\b[^>]*>/gi, "\n\n> ")
    .replace(/<\s*\/\s*blockquote\s*>/gi, "\n\n")
    .replace(/<\s*(strong|b)\b[^>]*>/gi, "**")
    .replace(/<\s*\/\s*(strong|b)\s*>/gi, "**")
    .replace(/<\s*(em|i)\b[^>]*>/gi, "*")
    .replace(/<\s*\/\s*(em|i)\s*>/gi, "*")
    .replace(/<\s*code\b[^>]*>/gi, "`")
    .replace(/<\s*\/\s*code\s*>/gi, "`");

  md = md.replace(
    /<\s*a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\s*\/\s*a\s*>/gi,
    (_all, href: string, label: string) => `[${label.trim()}](${href})`,
  );

  // Whatever tags are left are not on the allowlist. Show them, literally.
  md = md.replace(TAG, (all) => all.replace(/</g, "&lt;"));

  return parseMarkdown(decodeEntities(md));
}

/** Tags present in a richtext value that the site's templates will not render. */
export function unsupportedRichTextTags(source: string): string[] {
  const allowed = new Set<string>(RICHTEXT_TAGS);
  const found = new Set<string>();
  for (const m of (source ?? "").matchAll(TAG)) {
    const tag = m[1].toLowerCase();
    if (!allowed.has(tag)) found.add(tag);
  }
  return [...found].sort();
}

/** Plain text of a body, for excerpts and the collection list. */
export function toPlainText(blocks: MdBlock[]): string {
  return blocks
    .map((b) => {
      switch (b.kind) {
        case "rule":
          return "";
        case "code":
          return b.text;
        case "list":
          return b.items.map(inlineToText).join(" ");
        default:
          return inlineToText(b.inline);
      }
    })
    .filter(Boolean)
    .join("\n\n");
}
