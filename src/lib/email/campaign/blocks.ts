import { z } from "zod";
import type { EmailBlock, EmailLeafBlock } from "@/db/schema";

/**
 * ===========================================================================
 *  THE BLOCK PALETTE.
 *
 *  A campaign body is an array of blocks, not a blob of HTML. That is the
 *  single decision this whole module rests on, and it buys three things
 *  Wild Apricot's WYSIWYG does not:
 *
 *    1. The plain-text part is rendered FROM THE BLOCKS, not scraped out of
 *       the HTML. A heading knows it is a heading, so it can be underlined
 *       rather than left as a bare line; a button knows its URL, so it can be
 *       written out as "Register: https://…" instead of vanishing.
 *    2. Table-based HTML that survives Outlook is generated, never authored.
 *       Nobody has to remember cellpadding="0" or that Outlook ignores
 *       padding on an anchor.
 *    3. The review gate can ASK QUESTIONS OF THE STRUCTURE — "does every
 *       image have alt text?" is a loop over blocks, not a regex over markup.
 *
 *  `two-column` holds LEAF blocks only and is not recursive. Columns inside
 *  columns do not survive Outlook, and a builder that lets somebody try is a
 *  builder that ships broken mail.
 * ===========================================================================
 */

export type { EmailBlock, EmailLeafBlock };
export type BlockType = EmailBlock["type"];

/* ----------------------------------------------------------- validation */

const html = z.string().max(20000);
const shortText = z.string().max(500);
const href = z.string().max(2000);

const leafSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("heading"),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    text: shortText,
  }),
  z.object({ type: z.literal("paragraph"), html }),
  z.object({ type: z.literal("button"), label: shortText, href }),
  z.object({
    type: z.literal("image"),
    assetId: z.string().max(2000),
    // Non-empty is NOT enforced here: an image with no alt text yet is a
    // legitimate half-finished draft. It is enforced by the review gate,
    // which is where "you cannot send this" belongs.
    alt: z.string().max(500),
    href: href.optional(),
    width: z.number().int().min(40).max(600).optional(),
  }),
  z.object({ type: z.literal("divider") }),
  z.object({
    type: z.literal("spacer"),
    size: z.enum(["sm", "md", "lg"]),
  }),
  z.object({
    type: z.literal("list"),
    ordered: z.boolean(),
    items: z.array(shortText).max(60),
  }),
  z.object({
    type: z.literal("quote"),
    html,
    attribution: shortText.optional(),
  }),
  z.object({
    type: z.literal("event-card"),
    sourceId: z.string().nullish(),
    title: shortText,
    startsAt: z.string().max(80).nullish(),
    location: shortText.nullish(),
    summary: z.string().max(2000).nullish(),
    href: href.nullish(),
    ctaLabel: shortText.nullish(),
  }),
  z.object({
    type: z.literal("document-card"),
    sourceId: z.string().nullish(),
    title: shortText,
    description: z.string().max(2000).nullish(),
    meta: shortText.nullish(),
    href: href.nullish(),
    ctaLabel: shortText.nullish(),
  }),
  z.object({
    type: z.literal("member-data"),
    heading: shortText.nullish(),
    fields: z
      .array(
        z.object({
          field: z.string().max(64),
          label: shortText,
          fallback: shortText.nullish(),
        }),
      )
      .max(12),
  }),
  z.object({
    type: z.literal("dynamic"),
    source: z.enum(["upcoming-events", "recent-press", "agenda"]),
    limit: z.number().int().min(1).max(20),
  }),
]);

export const blockSchema: z.ZodType<EmailBlock> = z.union([
  leafSchema,
  z.object({
    type: z.literal("two-column"),
    left: z.array(leafSchema).max(20),
    right: z.array(leafSchema).max(20),
  }),
]) as z.ZodType<EmailBlock>;

/** A whole body. 200 blocks is far past anything a newsletter needs. */
export const blocksSchema = z.array(blockSchema).max(200);

/** Parses the JSON a composer form posts. Returns [] rather than throwing on
 *  a blank field, so an empty draft saves. */
export function parseBlocksJson(raw: string | null | undefined): EmailBlock[] {
  const s = (raw ?? "").trim();
  if (!s) return [];
  return blocksSchema.parse(JSON.parse(s));
}

/* -------------------------------------------------------------- palette */

export interface BlockDef {
  type: BlockType;
  label: string;
  /** One line, shown in the composer's "add a block" menu. */
  hint: string;
  /** May it sit inside a two-column block? */
  leaf: boolean;
  make: () => EmailBlock;
}

export const BLOCK_PALETTE: readonly BlockDef[] = [
  {
    type: "heading",
    label: "Heading",
    hint: "A section title. Rendered as a real <h1>/<h2>/<h3>, and underlined in the plain-text part.",
    leaf: true,
    make: () => ({ type: "heading", level: 2, text: "Section heading" }),
  },
  {
    type: "paragraph",
    label: "Paragraph",
    hint: "Body copy. Limited inline HTML: bold, italic, links.",
    leaf: true,
    make: () => ({ type: "paragraph", html: "" }),
  },
  {
    type: "image",
    label: "Image",
    hint: "A hosted image. Alt text is required before this campaign can be sent.",
    leaf: true,
    make: () => ({ type: "image", assetId: "", alt: "" }),
  },
  {
    type: "button",
    label: "Button",
    hint: "A call to action. Rendered as a padded table cell so Outlook keeps the box.",
    leaf: true,
    make: () => ({ type: "button", label: "Register", href: "" }),
  },
  {
    type: "divider",
    label: "Divider",
    hint: "A horizontal rule between sections.",
    leaf: true,
    make: () => ({ type: "divider" }),
  },
  {
    type: "spacer",
    label: "Spacer",
    hint: "Vertical space. Uses a sized table row, which Outlook honours and a margin is not.",
    leaf: true,
    make: () => ({ type: "spacer", size: "md" }),
  },
  {
    type: "list",
    label: "List",
    hint: "Bulleted or numbered. Becomes a real list in both renderings.",
    leaf: true,
    make: () => ({ type: "list", ordered: false, items: [""] }),
  },
  {
    type: "quote",
    label: "Pull quote",
    hint: "An indented quote with an optional attribution.",
    leaf: true,
    make: () => ({ type: "quote", html: "" }),
  },
  {
    type: "two-column",
    label: "Two columns",
    hint: "Side by side on a desktop, stacked on a phone. Holds simple blocks only — columns do not nest.",
    leaf: false,
    make: () => ({ type: "two-column", left: [], right: [] }),
  },
  {
    type: "event-card",
    label: "Event card",
    hint: "Date, place and a link. Pick a real event to fill it in; what is stored is the snapshot.",
    leaf: true,
    make: () => ({
      type: "event-card",
      title: "",
      startsAt: null,
      location: null,
      summary: null,
      href: null,
      ctaLabel: "Event details",
    }),
  },
  {
    type: "document-card",
    label: "Document card",
    hint: "A library document with its description and a link to the members' download.",
    leaf: true,
    make: () => ({
      type: "document-card",
      title: "",
      description: null,
      meta: null,
      href: null,
      ctaLabel: "Open the document",
    }),
  },
  {
    type: "member-data",
    label: "Member data",
    hint: "The recipient's own record — level, renewal date, councils. Every row carries a fallback.",
    leaf: true,
    make: () => ({
      type: "member-data",
      heading: "Your WACA membership",
      fields: [
        { field: "organization", label: "Organisation", fallback: null },
        { field: "membership_level", label: "Level", fallback: null },
        { field: "renewal_date", label: "Renews", fallback: null },
      ],
    }),
  },
  {
    type: "dynamic",
    label: "Upcoming events (live)",
    hint: "Filled in from live data when the message is rendered, rather than typed out.",
    leaf: true,
    make: () => ({ type: "dynamic", source: "upcoming-events", limit: 3 }),
  },
];

const PALETTE_BY_TYPE = new Map(BLOCK_PALETTE.map((b) => [b.type, b]));

export function blockLabel(type: BlockType): string {
  return PALETTE_BY_TYPE.get(type)?.label ?? type;
}

export function makeBlock(type: BlockType): EmailBlock {
  const def = PALETTE_BY_TYPE.get(type);
  if (!def) throw new Error(`unknown block type: ${type}`);
  return def.make();
}

/* --------------------------------------------------------- introspection */

/** Every block, with two-column children flattened out. Used by every check
 *  below, so a broken image inside a column is never missed. */
export function flattenBlocks(blocks: readonly EmailBlock[]): EmailLeafBlock[] {
  const out: EmailLeafBlock[] = [];
  for (const b of blocks) {
    if (b.type === "two-column") out.push(...b.left, ...b.right);
    else out.push(b);
  }
  return out;
}

export interface ImageIssue {
  index: number;
  reason: "no-alt" | "no-source";
  /** What the composer shows so the author can find it. */
  hint: string;
}

/** Images with no alt text, or no source. Both are review-gate failures. */
export function imageIssues(blocks: readonly EmailBlock[]): ImageIssue[] {
  const out: ImageIssue[] = [];
  flattenBlocks(blocks).forEach((b, index) => {
    if (b.type !== "image") return;
    if (!b.assetId.trim()) {
      out.push({ index, reason: "no-source", hint: "Image block has no file." });
      return;
    }
    if (!b.alt.trim()) {
      out.push({
        index,
        reason: "no-alt",
        hint: `Image "${b.assetId.split("/").pop() ?? b.assetId}" has no alt text.`,
      });
    }
  });
  return out;
}

/** Count of images, for the composer's summary line. */
export function countImages(blocks: readonly EmailBlock[]): number {
  return flattenBlocks(blocks).filter((b) => b.type === "image").length;
}

/**
 * Every author-supplied URL in the body, deduplicated and in document order.
 * The rendered footer's own links are NOT here — they are added by the
 * renderer and checked separately against the rendered HTML.
 */
export function collectBlockLinks(blocks: readonly EmailBlock[]): string[] {
  const out: string[] = [];
  const push = (v: string | null | undefined) => {
    const s = (v ?? "").trim();
    if (s && !out.includes(s)) out.push(s);
  };
  for (const b of flattenBlocks(blocks)) {
    switch (b.type) {
      case "button":
        push(b.href);
        break;
      case "image":
        push(b.href);
        break;
      case "event-card":
      case "document-card":
        push(b.href);
        break;
      case "paragraph":
      case "quote":
        for (const m of b.html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
          push(m[1]);
        }
        break;
      default:
        break;
    }
  }
  return out;
}

/** All author-written prose, for the merge-token scan and the spam advice. */
export function collectBlockText(blocks: readonly EmailBlock[]): string {
  const parts: string[] = [];
  for (const b of flattenBlocks(blocks)) {
    switch (b.type) {
      case "heading":
        parts.push(b.text);
        break;
      case "paragraph":
        parts.push(b.html);
        break;
      case "quote":
        parts.push(b.html, b.attribution ?? "");
        break;
      case "button":
        parts.push(b.label, b.href);
        break;
      case "image":
        parts.push(b.alt);
        break;
      case "list":
        parts.push(...b.items);
        break;
      case "event-card":
        parts.push(b.title, b.summary ?? "", b.location ?? "", b.ctaLabel ?? "");
        break;
      case "document-card":
        parts.push(b.title, b.description ?? "", b.meta ?? "", b.ctaLabel ?? "");
        break;
      case "member-data":
        parts.push(b.heading ?? "", ...b.fields.map((f) => f.label));
        break;
      default:
        break;
    }
  }
  return parts.filter(Boolean).join("\n");
}

/** True when there is anything a recipient would actually read. */
export function hasContent(blocks: readonly EmailBlock[]): boolean {
  return flattenBlocks(blocks).some((b) => {
    switch (b.type) {
      case "divider":
      case "spacer":
        return false;
      case "heading":
        return b.text.trim().length > 0;
      case "paragraph":
      case "quote":
        return b.html.replace(/<[^>]*>/g, "").trim().length > 0;
      case "list":
        return b.items.some((i) => i.trim().length > 0);
      case "image":
        return b.assetId.trim().length > 0;
      case "button":
        return b.label.trim().length > 0;
      case "event-card":
      case "document-card":
        return b.title.trim().length > 0;
      case "member-data":
        return b.fields.length > 0;
      case "dynamic":
        return true;
    }
  });
}
