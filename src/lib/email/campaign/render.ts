import { escapeHtml } from "@/lib/email/client";
import type { EmailBlock, EmailLeafBlock } from "@/db/schema";
import { flattenBlocks } from "./blocks";
import {
  POSTAL_ADDRESS_LINES,
  UNSUBSCRIBE_TOKEN,
} from "./compliance";
import {
  applyMerge,
  mergeFieldDef,
  type MergeContext,
} from "./merge";

/**
 * ===========================================================================
 *  ONE SET OF BLOCKS, TWO RENDERINGS.
 *
 *  renderBlocksHtml() and renderBlocksText() walk the SAME array. That is the
 *  point of the whole module: the plain-text part is not `html.replace(/<[^>]
 *  *>/g, "")` run at the end and hoped over, it is a first-class rendering
 *  that knows a heading is a heading and a button has a URL.
 *
 *  ------------------------------- OUTLOOK -------------------------------
 *  Outlook 2016+ on Windows renders through Word. Word does not support
 *  float, flexbox, grid, max-width, background-image, border-radius on a
 *  block, or padding on an inline anchor. So:
 *
 *    * every layout is a <table role="presentation"> with cellpadding="0"
 *      cellspacing="0" border="0"
 *    * width is a `width` ATTRIBUTE as well as a style
 *    * vertical space is a table row with a height, never a margin
 *    * a button is a <td bgcolor> with padding, containing a bare <a> —
 *      padding on the anchor would be dropped and the box would collapse
 *    * two columns are two <td>s; the mobile stack is a media query, which
 *      Word ignores, leaving the desktop layout it can actually draw
 *    * <!--[if mso]> is used only to force a fallback font, not for layout
 *  -----------------------------------------------------------------------
 * ===========================================================================
 */

const CONTENT_WIDTH = 600;
const INK = "#18181b";
const MUTED = "#71717a";
const RULE = "#e4e4e7";
const WASH = "#fafafa";
const PAGE = "#f4f4f5";

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/* ======================================================================
 *  Inline HTML: a small allowlist, applied on the way out.
 * ==================================================================== */

const ALLOWED_INLINE = new Set(["b", "strong", "i", "em", "u", "br", "a", "span"]);

/**
 * Paragraph and quote bodies are author-written HTML. They come from signed-in
 * WACA staff, but "the author is trusted" is not a sanitisation strategy: a
 * pasted <script>, a pasted `onclick`, or a `javascript:` href would all end
 * up in an email and, via the hosted view-in-browser copy, in a browser.
 *
 * So the allowlist is applied HERE, in the renderer, rather than in the
 * composer — because the renderer is the only thing every body passes through.
 */
export function sanitizeInlineHtml(raw: string): string {
  let out = "";
  let index = 0;
  const tagRe = /<\/?([a-z0-9]+)((?:\s+[^<>]*)?)\/?>/gi;
  for (const m of raw.matchAll(tagRe)) {
    const at = m.index ?? 0;
    out += escapeHtml(raw.slice(index, at));
    index = at + m[0].length;

    const name = m[1].toLowerCase();
    if (!ALLOWED_INLINE.has(name)) continue; // drop the tag, keep going

    const closing = m[0].startsWith("</");
    if (closing) {
      out += `</${name}>`;
      continue;
    }
    if (name === "br") {
      out += "<br/>";
      continue;
    }
    if (name === "a") {
      const href = /href\s*=\s*["']([^"']*)["']/i.exec(m[2] ?? "")?.[1] ?? "";
      const safe = safeHref(href);
      out += safe
        ? `<a href="${escapeHtml(safe)}" style="color:${INK};text-decoration:underline">`
        : "<a>";
      continue;
    }
    out += `<${name}>`;
  }
  out += escapeHtml(raw.slice(index));
  return out;
}

/**
 * A URL we are willing to put in an email.
 *
 * `javascript:` and `data:` are dropped outright. A merge token passes through
 * unchanged — it is replaced by a real URL per recipient at send time.
 *
 * A ROOT-RELATIVE PATH IS MADE ABSOLUTE. `/events` is what somebody who has
 * been editing web pages all morning will type, and in an email it is simply
 * broken — there is no page for a mail client to resolve it against. Rather
 * than fail it at the gate, it is resolved here against NEXT_PUBLIC_APP_URL.
 *
 * That resolution is FROZEN into the stored body at save time, which is the
 * correct behaviour and worth stating plainly: changing NEXT_PUBLIC_APP_URL
 * after a campaign has been approved does not rewrite the approved body. What
 * a human read and signed off is what goes out.
 */
export function safeHref(raw: string): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (/^\{\{[a-z0-9_]+(\|[^}]*)?\}\}$/i.test(s)) return s;
  if (/^(https?:|mailto:|tel:)/i.test(s)) return s;
  if (s.startsWith("/")) {
    const origin = (
      process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
    ).replace(/\/+$/, "");
    return `${origin}${s}`;
  }
  // A bare fragment cannot mean anything in an email: there is no document to
  // scroll. Dropped rather than rendered as a dead link.
  return null;
}

/** HTML -> readable plain text. Links become "text (url)", not nothing. */
export function inlineHtmlToText(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(
      /<a[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href: string, label: string) => {
        const text = label.replace(/<[^>]*>/g, "").trim();
        const url = (href ?? "").trim();
        if (!url) return text;
        // Don't print "WACA (WACA)" when the label already is the URL.
        return text && text !== url ? `${text} (${url})` : url;
      },
    )
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

const WRAP_AT = 72;

/** Greedy wrap that never breaks a long URL across lines. */
export function wrap(text: string, width = WRAP_AT, indent = ""): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.length + indent.length <= width) return indent + line;
      const words = line.split(/\s+/).filter(Boolean);
      const out: string[] = [];
      let current = "";
      for (const word of words) {
        if (!current) current = word;
        else if (current.length + 1 + word.length + indent.length <= width) {
          current += ` ${word}`;
        } else {
          out.push(indent + current);
          current = word;
        }
      }
      if (current) out.push(indent + current);
      return out.join("\n");
    })
    .join("\n");
}

/* ======================================================================
 *  HTML
 * ==================================================================== */

const SPACER_PX = { sm: 8, md: 20, lg: 40 } as const;

function td(inner: string, padding = "0 24px"): string {
  return `<tr><td style="padding:${padding};font-family:${FONT};font-size:15px;line-height:1.6;color:${INK}">${inner}</td></tr>`;
}

function leafHtml(block: EmailLeafBlock, narrow: boolean): string {
  switch (block.type) {
    case "heading": {
      const size = block.level === 1 ? 24 : block.level === 2 ? 19 : 16;
      return td(
        `<h${block.level} style="margin:0;padding:18px 0 6px;font-family:${FONT};font-size:${size}px;line-height:1.3;font-weight:600;letter-spacing:-0.01em;color:${INK}">${escapeHtml(
          block.text,
        )}</h${block.level}>`,
        narrow ? "0" : "0 24px",
      );
    }

    case "paragraph":
      return td(
        `<p style="margin:0;padding:8px 0">${sanitizeInlineHtml(block.html)}</p>`,
        narrow ? "0" : "0 24px",
      );

    case "quote":
      return td(
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:14px 0">
           <tr>
             <td style="border-left:3px solid ${INK};padding:4px 0 4px 14px;font-family:${FONT};font-size:16px;line-height:1.6;color:${INK}">
               ${sanitizeInlineHtml(block.html)}
               ${
                 block.attribution
                   ? `<div style="margin-top:6px;font-size:13px;color:${MUTED}">— ${escapeHtml(block.attribution)}</div>`
                   : ""
               }
             </td>
           </tr>
         </table>`,
        narrow ? "0" : "0 24px",
      );

    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      const items = block.items
        .filter((i) => i.trim())
        .map(
          (i) =>
            `<li style="margin:0 0 6px">${sanitizeInlineHtml(i)}</li>`,
        )
        .join("");
      if (!items) return "";
      return td(
        `<${tag} style="margin:8px 0;padding-left:22px;font-family:${FONT};font-size:15px;line-height:1.6;color:${INK}">${items}</${tag}>`,
        narrow ? "0" : "0 24px",
      );
    }

    case "image": {
      if (!block.assetId.trim()) return "";
      const width = block.width ?? (narrow ? 260 : CONTENT_WIDTH - 48);
      const img = `<img src="${escapeHtml(block.assetId)}" alt="${escapeHtml(block.alt)}" width="${width}" style="display:block;width:100%;max-width:${width}px;height:auto;border:0;outline:none;text-decoration:none" />`;
      const link = safeHref(block.href ?? "");
      return td(
        `<div style="padding:10px 0">${link ? `<a href="${escapeHtml(link)}">${img}</a>` : img}</div>`,
        narrow ? "0" : "0 24px",
      );
    }

    case "button": {
      const link = safeHref(block.href) ?? "#";
      // Padding lives on the TD. Outlook drops padding on an inline <a>, and
      // a button whose box collapses to the text is not a button.
      return td(
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0">
           <tr>
             <td bgcolor="${INK}" style="background:${INK};border:1px solid ${INK};border-radius:4px;padding:11px 22px">
               <a href="${escapeHtml(link)}" style="font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;display:inline-block">${escapeHtml(
                 block.label,
               )}</a>
             </td>
           </tr>
         </table>`,
        narrow ? "0" : "0 24px",
      );
    }

    case "divider":
      return td(
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td style="border-top:1px solid ${RULE};font-size:0;line-height:0;height:1px">&nbsp;</td></tr></table>`,
        narrow ? "14px 0" : "14px 24px",
      );

    case "spacer":
      return `<tr><td style="height:${SPACER_PX[block.size]}px;font-size:0;line-height:0">&nbsp;</td></tr>`;

    case "event-card": {
      const link = safeHref(block.href ?? "");
      const meta = [block.startsAt, block.location].filter(Boolean).join(" · ");
      return td(
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${WASH}" style="margin:12px 0;border:1px solid ${RULE};border-radius:4px">
           <tr><td style="padding:14px 16px;font-family:${FONT}">
             <div style="font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${MUTED}">Event</div>
             <div style="margin-top:4px;font-size:17px;font-weight:600;line-height:1.3;color:${INK}">${escapeHtml(block.title)}</div>
             ${meta ? `<div style="margin-top:4px;font-size:13px;color:${MUTED}">${escapeHtml(meta)}</div>` : ""}
             ${block.summary ? `<div style="margin-top:8px;font-size:14px;line-height:1.55;color:${INK}">${sanitizeInlineHtml(block.summary)}</div>` : ""}
             ${
               link
                 ? `<div style="margin-top:10px"><a href="${escapeHtml(link)}" style="font-size:14px;font-weight:600;color:${INK}">${escapeHtml(block.ctaLabel || "Event details")} →</a></div>`
                 : ""
             }
           </td></tr>
         </table>`,
        narrow ? "0" : "0 24px",
      );
    }

    case "document-card": {
      const link = safeHref(block.href ?? "");
      return td(
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:12px 0;border:1px solid ${RULE};border-radius:4px">
           <tr><td style="padding:14px 16px;font-family:${FONT}">
             <div style="font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${MUTED}">Document</div>
             <div style="margin-top:4px;font-size:16px;font-weight:600;line-height:1.35;color:${INK}">${escapeHtml(block.title)}</div>
             ${block.meta ? `<div style="margin-top:3px;font-size:12px;color:${MUTED}">${escapeHtml(block.meta)}</div>` : ""}
             ${block.description ? `<div style="margin-top:8px;font-size:14px;line-height:1.55;color:${INK}">${sanitizeInlineHtml(block.description)}</div>` : ""}
             ${
               link
                 ? `<div style="margin-top:10px"><a href="${escapeHtml(link)}" style="font-size:14px;font-weight:600;color:${INK}">${escapeHtml(block.ctaLabel || "Open the document")} →</a></div>`
                 : ""
             }
           </td></tr>
         </table>`,
        narrow ? "0" : "0 24px",
      );
    }

    case "member-data": {
      if (!block.fields.length) return "";
      const rows = block.fields
        .map((f) => {
          const def = mergeFieldDef(f.field);
          const token = f.fallback?.trim()
            ? `{{${f.field}|${f.fallback.trim()}}}`
            : `{{${f.field}}}`;
          return `<tr>
            <td style="padding:4px 14px 4px 0;font-size:12px;color:${MUTED};white-space:nowrap;vertical-align:top">${escapeHtml(
              f.label || def?.label || f.field,
            )}</td>
            <td style="padding:4px 0;font-size:14px;color:${INK}">${escapeHtml(token)}</td>
          </tr>`;
        })
        .join("");
      return td(
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${WASH}" style="margin:12px 0;border:1px solid ${RULE};border-radius:4px">
           <tr><td style="padding:14px 16px;font-family:${FONT}">
             ${
               block.heading
                 ? `<div style="font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${MUTED};margin-bottom:6px">${escapeHtml(block.heading)}</div>`
                 : ""
             }
             <table role="presentation" cellpadding="0" cellspacing="0" border="0">${rows}</table>
           </td></tr>
         </table>`,
        narrow ? "0" : "0 24px",
      );
    }

    case "dynamic":
      // A placeholder the send worker replaces. It renders as visible text
      // rather than as nothing, so an unresolved dynamic block is obvious in
      // a preview instead of being a silent gap in the sent message.
      return td(
        `<div style="margin:12px 0;padding:12px 14px;border:1px dashed ${RULE};font-size:13px;color:${MUTED}">Live block: ${escapeHtml(
          block.source,
        )} (up to ${block.limit}). Filled in when this campaign is rendered for sending.</div>`,
        narrow ? "0" : "0 24px",
      );
  }
}

function blockHtml(block: EmailBlock): string {
  if (block.type !== "two-column") return leafHtml(block, false);

  const column = (children: EmailLeafBlock[]) =>
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${children
      .map((c) => leafHtml(c, true))
      .join("")}</table>`;

  return `<tr><td style="padding:6px 24px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td class="waca-col" width="50%" valign="top" style="width:50%;padding-right:12px">${column(block.left)}</td>
        <td class="waca-col" width="50%" valign="top" style="width:50%;padding-left:12px">${column(block.right)}</td>
      </tr>
    </table>
  </td></tr>`;
}

export interface RenderInput {
  subject: string;
  preheader?: string | null;
  blocks: readonly EmailBlock[];
  /** Shown above the footer, e.g. "You are receiving this as a WACA member." */
  audienceNote?: string | null;
  /**
   * WHICH FOOTER. Added by the delivery module so WACA has ONE renderer
   * rather than two email systems.
   *
   *   'marketing'      (default) postal address + the CAN-SPAM opt-out link.
   *                    Every campaign. Not optional, not removable.
   *   'transactional'  postal address, and NO unsubscribe link.
   *
   * The transactional footer is a deliberate omission, not a shortcut. An
   * invoice, a receipt, a renewal notice and a registration confirmation are
   * service messages about a relationship the recipient is already in;
   * CAN-SPAM does not require an opt-out on them, and offering one would be a
   * promise WACA cannot keep — we are going to send you your invoice either
   * way. A footer that says "unsubscribe" and then does not is worse for
   * trust, and for deliverability, than no footer link at all. What it says
   * instead is why the message arrived and who to write to.
   *
   * Note what does NOT change: the postal address is appended in both modes,
   * and neither mode can be switched off from a template or a block.
   */
  footer?: "marketing" | "transactional";
}

/**
 * THE HTML rendering. Always ends with the CAN-SPAM footer — the postal
 * address and the unsubscribe link are appended by this function and are not
 * blocks, so they cannot be deleted, reordered or "temporarily removed".
 */
export function renderBlocksHtml(input: RenderInput): string {
  const body = input.blocks.map(blockHtml).join("");
  const preheader = (input.preheader ?? "").trim();

  return `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${escapeHtml(input.subject)}</title>
<!--[if mso]><style>body,table,td,a{font-family:Arial,Helvetica,sans-serif !important}</style><![endif]-->
<style>
  /* Word ignores every rule in here, which is why nothing structural lives in it. */

  /* DARK MODE. This template is light-only and says so, twice: in the two
     meta tags above and here. Declaring a scheme is what stops Apple Mail and
     Outlook.com applying their own automatic inversion, which does not invert
     evenly — it flips the page background and leaves an explicit colour declaration on
     the text alone, and the result is grey-on-grey body copy or, on the dark
     header band, white on near-white. Every coloured surface below therefore
     carries BOTH a "bgcolor" attribute and a "background" style, because a
     client that ignores one usually honours the other. */
  :root { color-scheme: light; supported-color-schemes: light; }

  @media only screen and (max-width:620px) {
    .waca-shell { width:100% !important; }
    .waca-col { display:block !important; width:100% !important; padding:0 0 12px 0 !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${PAGE};-webkit-font-smoothing:antialiased">
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${escapeHtml(
    preheader,
  )}</div>
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;opacity:0;overflow:hidden;mso-hide:all">&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${PAGE}">
    <tr>
      <td align="center" style="padding:24px 12px">
        <table role="presentation" class="waca-shell" cellpadding="0" cellspacing="0" border="0" width="${CONTENT_WIDTH}" style="width:${CONTENT_WIDTH}px;max-width:${CONTENT_WIDTH}px;background:#ffffff;border:1px solid ${RULE};border-radius:6px">

          <tr>
            <td bgcolor="${INK}" style="padding:16px 24px;border-radius:6px 6px 0 0">
              <div style="font-family:${FONT};font-size:15px;font-weight:600;letter-spacing:-0.01em;color:#ffffff">Washington CannaBusiness Association</div>
              ${
                (input.footer ?? "marketing") === "transactional"
                  ? ""
                  : `<div style="font-family:${FONT};font-size:11px;color:#a1a1aa;margin-top:2px">
                <a href="{{view_in_browser_url}}" style="color:#a1a1aa;text-decoration:underline">View this email in your browser</a>
              </div>`
              }
            </td>
          </tr>

          <tr><td style="height:8px;font-size:0;line-height:0">&nbsp;</td></tr>
          ${body}
          <tr><td style="height:20px;font-size:0;line-height:0">&nbsp;</td></tr>

          <tr>
            <td style="border-top:1px solid ${RULE};padding:16px 24px;font-family:${FONT};font-size:11px;line-height:1.6;color:${MUTED}">
              ${
                input.audienceNote
                  ? `<div style="margin-bottom:8px">${escapeHtml(input.audienceNote)}</div>`
                  : ""
              }
              <div>${POSTAL_ADDRESS_LINES.map((l) => escapeHtml(l)).join("<br/>")}</div>
              ${
                (input.footer ?? "marketing") === "transactional"
                  ? `<div style="margin-top:8px">This is a service message about your WACA membership, invoice or registration, not a mailing list. Reply to this email if it reached you in error.</div>`
                  : `<div style="margin-top:8px">
                <a href="${UNSUBSCRIBE_TOKEN}" style="color:${MUTED};text-decoration:underline">Unsubscribe from WACA email</a>
              </div>`
              }
              <div style="margin-top:8px">WACA does not accept card payments. Invoices are settled by cheque, ACH or bank transfer.</div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/* ======================================================================
 *  PLAIN TEXT
 * ==================================================================== */

function leafText(block: EmailLeafBlock, indent = ""): string[] {
  switch (block.type) {
    case "heading": {
      const text = block.text.trim();
      if (!text) return [];
      const rule = (block.level === 1 ? "=" : "-").repeat(
        Math.min(text.length, WRAP_AT),
      );
      // A heading that is underlined is a heading. A heading that is merely a
      // short line is a short line.
      return block.level === 3
        ? ["", `${indent}${text.toUpperCase()}`]
        : ["", `${indent}${text}`, `${indent}${rule}`];
    }

    case "paragraph": {
      const text = inlineHtmlToText(block.html);
      return text ? ["", wrap(text, WRAP_AT, indent)] : [];
    }

    case "quote": {
      const text = inlineHtmlToText(block.html);
      if (!text) return [];
      const lines = ["", wrap(text, WRAP_AT - 2, `${indent}> `)];
      if (block.attribution) lines.push(`${indent}>   — ${block.attribution}`);
      return lines;
    }

    case "list": {
      const items = block.items.filter((i) => i.trim());
      if (!items.length) return [];
      return [
        "",
        ...items.map((item, i) => {
          const marker = block.ordered ? `${i + 1}. ` : "- ";
          const text = inlineHtmlToText(item);
          const wrapped = wrap(text, WRAP_AT - marker.length - indent.length);
          const [first, ...rest] = wrapped.split("\n");
          return [
            `${indent}${marker}${first}`,
            ...rest.map((r) => `${indent}${" ".repeat(marker.length)}${r}`),
          ].join("\n");
        }),
      ];
    }

    case "image": {
      if (!block.assetId.trim()) return [];
      const alt = block.alt.trim();
      // The alt text IS the content here — this is the reason alt text is a
      // blocking check and not a nag.
      return ["", `${indent}[Image: ${alt || "no description provided"}]`];
    }

    case "button": {
      const href = safeHref(block.href);
      if (!block.label.trim() && !href) return [];
      return ["", `${indent}${block.label.trim() || "Open"}: ${href ?? "(no link set)"}`];
    }

    case "divider":
      return ["", `${indent}${"-".repeat(Math.min(WRAP_AT, 48))}`];

    case "spacer":
      return [""];

    case "event-card": {
      const lines = ["", `${indent}EVENT — ${block.title}`];
      const meta = [block.startsAt, block.location].filter(Boolean).join(" · ");
      if (meta) lines.push(`${indent}${meta}`);
      if (block.summary) {
        lines.push(wrap(inlineHtmlToText(block.summary), WRAP_AT, indent));
      }
      const href = safeHref(block.href ?? "");
      if (href) lines.push(`${indent}${block.ctaLabel || "Event details"}: ${href}`);
      return lines;
    }

    case "document-card": {
      const lines = ["", `${indent}DOCUMENT — ${block.title}`];
      if (block.meta) lines.push(`${indent}${block.meta}`);
      if (block.description) {
        lines.push(wrap(inlineHtmlToText(block.description), WRAP_AT, indent));
      }
      const href = safeHref(block.href ?? "");
      if (href) {
        lines.push(`${indent}${block.ctaLabel || "Open the document"}: ${href}`);
      }
      return lines;
    }

    case "member-data": {
      if (!block.fields.length) return [];
      const lines = ["", `${indent}${block.heading || "Your WACA record"}`];
      const width = Math.max(
        ...block.fields.map((f) => (f.label || f.field).length),
      );
      for (const f of block.fields) {
        const token = f.fallback?.trim()
          ? `{{${f.field}|${f.fallback.trim()}}}`
          : `{{${f.field}}}`;
        lines.push(
          `${indent}  ${(f.label || f.field).padEnd(width)}  ${token}`,
        );
      }
      return lines;
    }

    case "dynamic":
      return [
        "",
        `${indent}[Live block: ${block.source}, up to ${block.limit} items]`,
      ];
  }
}

/**
 * THE plain-text rendering, from the same blocks. Not a stripped-tags
 * afterthought: headings are underlined, lists keep their markers and hang
 * their wrap, buttons print their URL, and a two-column block becomes two
 * labelled sections in reading order rather than an interleaved mess.
 */
export function renderBlocksText(input: RenderInput): string {
  const lines: string[] = [];

  const preheader = (input.preheader ?? "").trim();
  const subject = input.subject.trim();

  /**
   * The subject goes at the top -- unless the body already opens with a
   * heading that says the same thing, which is the common case when somebody
   * titles the email and then titles the first section identically. Printing
   * both gives a plain-text part that says its own name twice before it says
   * anything.
   */
  const first = input.blocks[0];
  const opensWithTheTitle =
    first?.type === "heading" &&
    first.text.trim().toLowerCase() === subject.toLowerCase();

  if (!opensWithTheTitle) {
    lines.push(subject);
    lines.push("=".repeat(Math.min(subject.length || 1, WRAP_AT)));
  }
  if (preheader) {
    lines.push("");
    lines.push(wrap(preheader));
  }

  for (const block of input.blocks) {
    if (block.type === "two-column") {
      // Two columns cannot be two columns in a 72-character terminal. They are
      // rendered in reading order, left then right, which is what a screen
      // reader does with them anyway.
      lines.push(...block.left.flatMap((b) => leafText(b)));
      lines.push(...block.right.flatMap((b) => leafText(b)));
      continue;
    }
    lines.push(...leafText(block));
  }

  lines.push("");
  lines.push("-".repeat(Math.min(WRAP_AT, 48)));
  if (input.audienceNote) {
    lines.push(wrap(input.audienceNote));
    lines.push("");
  }
  for (const line of POSTAL_ADDRESS_LINES) lines.push(line);
  lines.push("");
  if ((input.footer ?? "marketing") === "transactional") {
    lines.push(
      wrap(
        "This is a service message about your WACA membership, invoice or registration, not a mailing list. Reply to this email if it reached you in error.",
      ),
    );
  } else {
    lines.push(`Unsubscribe from WACA email: ${UNSUBSCRIBE_TOKEN}`);
    lines.push(`View in your browser: {{view_in_browser_url}}`);
  }
  lines.push("");
  lines.push(
    wrap(
      "WACA does not accept card payments. Invoices are settled by cheque, ACH or bank transfer.",
    ),
  );

  // Collapse runs of blank lines; the block walkers each emit a leading blank
  // and two adjacent blocks should not open a chasm.
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .trimEnd()
    .concat("\n");
}

/* ======================================================================
 *  The one entry point everything else uses.
 * ==================================================================== */

export interface RenderedCampaign {
  html: string;
  text: string;
}

/** Render both parts from one set of blocks. Nothing renders one without the
 *  other, which is how they stay in step. */
export function renderCampaign(input: RenderInput): RenderedCampaign {
  return {
    html: renderBlocksHtml(input),
    text: renderBlocksText(input),
  };
}

/** Render, then substitute one recipient's merge fields into both parts. */
export function renderCampaignFor(
  input: RenderInput,
  ctx: MergeContext,
): RenderedCampaign & { subject: string; preheader: string } {
  const base = renderCampaign(input);
  return {
    // The subject is a header, not markup: escaping it would put `&amp;` in
    // somebody's inbox. The HTML part is escaped; the text part is not.
    subject: applyMerge(input.subject, ctx),
    preheader: applyMerge(input.preheader ?? "", ctx),
    html: applyMerge(base.html, ctx, { escape: true }),
    text: applyMerge(base.text, ctx),
  };
}

/** Every href in a rendered body, for the review gate's link check. */
export function extractHrefs(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const v = m[1].trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Unused import guard: flattenBlocks is re-exported for callers that walk a
 *  body without wanting two modules. */
export { flattenBlocks };
