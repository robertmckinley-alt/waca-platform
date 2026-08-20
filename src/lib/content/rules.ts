import type { ContentTypeKey } from "@/db/queries";
import type { EditorField } from "./fields";

/**
 * ============================================================================
 *  THE EDITORIAL AND ACCESSIBILITY RULES, WHERE THE EDITOR CAN SEE THEM.
 *
 *  The public site passes its gates because of a handful of rules that are
 *  currently enforced at the far end of the pipeline — in content.config.ts,
 *  in src/lib/stats.ts, in tools/check-hero-scrim.mjs. Every one of them is a
 *  build failure, which means the person who broke it finds out from a deploy
 *  log, hours later, and usually is not the person who can fix it.
 *
 *  So they are stated HERE, in the editor, beside the field they govern:
 *
 *    HARD  — a rule the site's build enforces. Blocks Publish. Lives in
 *            site-schemas.ts as a Zod rule and is quoted here for the editor.
 *    SOFT  — house style. Shown as a note, never blocks anything. A rule that
 *            blocks on a judgement call is a rule staff learn to route around.
 *
 *  Nothing in this file decides anything on its own; validate.ts runs it.
 * ============================================================================
 */

export interface EditorialRule {
  id: string;
  /** The field it governs, when it governs one. */
  field?: string;
  severity: "hard" | "soft";
  title: string;
  body: string;
}

/** Rules shown in the editor sidebar for every collection. */
export const UNIVERSAL_RULES: EditorialRule[] = [
  {
    id: "alt-text",
    severity: "hard",
    title: "Every image carries alt text, or is declared decorative",
    body:
      "An image with neither cannot be saved to the media library — there is a " +
      "CHECK constraint on the table, not just a rule in this form. If the image " +
      "carries no information (a texture, a rule, a divider), tick “decorative” " +
      "and it renders as alt=\"\". There is no third state.",
  },
  {
    id: "slug-stability",
    severity: "soft",
    title: "A published slug is a public URL",
    body:
      "Changing it breaks every inbound link, every share, and every citation. " +
      "Change it only when the old URL was wrong, and tell whoever maintains the " +
      "redirects.",
  },
];

export const RULES_BY_TYPE: Record<ContentTypeKey, EditorialRule[]> = {
  page: [
    {
      id: "page-meta",
      field: "metaDescription",
      severity: "soft",
      title: "Meta descriptions stop at about 160 characters",
      body:
        "Past that, search results truncate mid-sentence. Say what the page is " +
        "for in one sentence and stop.",
    },
    {
      id: "page-lede",
      field: "lede",
      severity: "hard",
      title: "Every page needs a lede",
      body:
        "The lede is what renders under the heading and what the card for this " +
        "page shows elsewhere on the site. A page without one renders a gap.",
    },
  ],
  press: [
    {
      id: "press-headline",
      field: "headline",
      severity: "soft",
      title: "A headline should name a number, a bill or a date",
      body:
        "“WACA responds to LCB proposal” tells a reader nothing they can act on. " +
        "“WACA opposes 37% excise increase in HB 2022” tells them the number, the " +
        "bill and the position. This is house style, not a build rule — it will " +
        "not stop you publishing.",
    },
    {
      id: "press-topics",
      field: "topics",
      severity: "hard",
      title: "Topics come from a fixed list",
      body:
        "The topic filter on /media is built from these values. A new topic has " +
        "to be added to the site's schema first, or the build fails and the " +
        "filter grows a facet with one item in it.",
    },
    {
      id: "press-audio",
      field: "audio",
      severity: "hard",
      title: "Broadcast audio needs a transcript",
      body:
        "Same rule as the advocacy record. Audio-only content requires a text " +
        "alternative under WCAG 2.1 SC 1.2.1 (Level A).",
    },
  ],
  record: [
    {
      id: "record-transcript",
      field: "transcript",
      severity: "hard",
      title: "Audio needs a transcript, or it is withheld",
      body:
        "Eight recordings came off the old site with no transcript, no caption " +
        "and no summary. They were unusable to deaf and hard-of-hearing visitors " +
        "and invisible to search. The build refuses to publish audio without a " +
        "text equivalent (WCAG 2.1 SC 1.2.1, Level A). If it cannot be " +
        "transcribed yet, set the audio status to “withheld”: the record is " +
        "catalogued and described, and no <audio> element is emitted.",
    },
    {
      id: "record-bill",
      field: "billNumber",
      severity: "soft",
      title: "Name the bill if there is one",
      body:
        "The advocacy record is searched by bill number more than by title. " +
        "“HB 2022”, “SB 5052”, or the WAC citation for a rulemaking comment.",
    },
  ],
  agenda: [
    {
      id: "agenda-documents",
      field: "documents",
      severity: "hard",
      title: "Every attached document needs a label",
      body:
        "The label is the link text. “2026 agenda (PDF)” is a link; " +
        "“agenda-2026-final-v3.pdf” is a filename, and a screen-reader user " +
        "hearing a list of links gets the filename read out character by " +
        "character.",
    },
  ],
  post: [
    {
      id: "post-headline",
      field: "title",
      severity: "soft",
      title: "A title should name a number, a bill or a date",
      body:
        "Same house rule as press. The blog index is a list of titles and " +
        "nothing else; each one has to earn its click on its own.",
    },
    {
      id: "post-image",
      field: "image",
      severity: "hard",
      title: "A post image needs alt text",
      body:
        "Chosen from the media library, where the alt text already lives. An " +
        "asset with no alt text cannot be chosen here.",
    },
  ],
  person: [
    {
      id: "person-order",
      severity: "soft",
      title: "Order is the sort order in the sidebar",
      body:
        "The leadership page lists board then staff, each in this order. " +
        "Officers first is the convention on the live page.",
    },
    {
      id: "person-headshot",
      field: "headshot",
      severity: "hard",
      title: "A headshot needs alt text",
      body:
        "Describe the person, not the photograph: “Dana Whitfield, head and " +
        "shoulders”. Four people on the live site have no headshot at all, and " +
        "that is fine — no image is better than an unlabelled one.",
    },
  ],
  member: [
    {
      id: "member-consent",
      field: "consentPublicListing",
      severity: "hard",
      title: "A member is listed publicly only with consent",
      body:
        "86 active members across 54 organisations; 47 consent to a public " +
        "listing. This box defaults to unticked on both sides of the pipeline, " +
        "so a new record cannot leak an organisation onto the public directory " +
        "by omission. Do not tick it on somebody's behalf.",
    },
  ],
  stat: [
    {
      id: "stat-source",
      field: "sourceTitle",
      severity: "hard",
      title: "No figure is published without its source",
      body:
        "src/lib/stats.ts throws at build time on a figure it cannot attribute. " +
        "These are the numbers WACA argues policy with; an unsourced number is " +
        "not evidence. Give the study, the author and the year.",
    },
    {
      id: "stat-asof",
      field: "asOf",
      severity: "hard",
      title: "Every figure carries the date it describes",
      body:
        "Not the date you typed it — the year of the data. The employment " +
        "figures on the home page describe 2020 and are printed “as of 2020” for " +
        "that reason.",
    },
    {
      id: "stat-download",
      field: "sourceUrl",
      severity: "soft",
      title: "Leave the source URL empty if the study is not online",
      body:
        "The Economic Impact Analysis is available only by emailing " +
        "media@wacannabusiness.org. An empty URL is the machine-readable form of " +
        "that, and the footnote says so instead of rendering a dead download " +
        "link.",
    },
  ],
  nav: [
    {
      id: "nav-primary",
      field: "primary",
      severity: "hard",
      title: "Six primary items, deliberately",
      body:
        "The nav is a statement about what the association does. Adding a " +
        "seventh is an editorial decision, not a convenience — take it to " +
        "whoever owns the information architecture first.",
    },
  ],
  setting: [
    {
      id: "setting-verified",
      severity: "hard",
      title: "Nothing in site settings may be invented",
      body:
        "Every value here is rendered as fact in the site chrome — the address, " +
        "the contact addresses, the founding year. If a value is unknown, leave " +
        "it empty: the templates render nothing rather than a guess.",
    },
  ],
};

export function rulesFor(type: ContentTypeKey): EditorialRule[] {
  return [...(RULES_BY_TYPE[type] ?? []), ...UNIVERSAL_RULES];
}

/** The rules that govern one field, for the note under its control. */
export function rulesForField(
  type: ContentTypeKey,
  field: EditorField,
): EditorialRule[] {
  return (RULES_BY_TYPE[type] ?? []).filter((r) => r.field === field.name);
}

/* ------------------------------------------------------------------ *
 * The one SOFT rule that needs code rather than prose.                 *
 * ------------------------------------------------------------------ */

const BILL_PATTERN = /\b(?:[HS]B|SJR|HJR|SCR|HCR|WAC|RCW)\s?\d/i;
const NUMBER_PATTERN = /\d/;
const MONTH_PATTERN =
  /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i;

/**
 * "A headline should name a number, a bill or a date."
 *
 * Advisory only, and deliberately generous: any digit counts, because a year,
 * a percentage, a dollar figure and a bill number are all the thing this rule
 * is actually asking for — something specific.
 */
export function headlineNamesSomethingSpecific(headline: string): boolean {
  return (
    BILL_PATTERN.test(headline) ||
    NUMBER_PATTERN.test(headline) ||
    MONTH_PATTERN.test(headline)
  );
}
