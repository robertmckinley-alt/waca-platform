import { z } from "zod";
import type { ContentTypeKey } from "@/db/queries";

/**
 * ============================================================================
 *  THE SITE'S OWN SCHEMAS, MIRRORED.
 *
 *  waca-web/src/content.config.ts is the public site's build-time contract.
 *  If a field there is `z.enum([...])` and the CMS writes a value outside the
 *  enum, `astro build` fails — at deploy time, in a log nobody is watching,
 *  after Publish has already fired the deploy hook and told a staffer their
 *  press release is live.
 *
 *  So the same rules are enforced HERE, in the editor, before Publish is
 *  reachable. This file is the mirror.
 *
 *  ----------------------------------------------------------------------
 *  HOW THIS STAYS IN SYNC — read this before changing either side.
 *  ----------------------------------------------------------------------
 *
 *  1. The two repositories are separate deployments and cannot import each
 *     other. A shared package would be a third thing to version and would
 *     couple a static marketing site to a Postgres application; it was
 *     rejected. This is a deliberate, documented duplicate.
 *
 *  2. `SITE_SCHEMA_PROVENANCE` below records the exact file, the collections
 *     it covers, and the shape of every enum. `npm run test:cms` re-reads
 *     waca-web/src/content.config.ts from disk and asserts that every enum
 *     vocabulary in it appears here identically. A new press topic added on
 *     the site and not added here fails that check with the missing value
 *     named. That test is the sync mechanism; this comment is not.
 *
 *  3. Where the two genuinely differ, the difference is named in a comment
 *     with the reason. There are exactly three:
 *
 *     a. `image()`. Astro's image() helper resolves a local file to
 *        ImageMetadata at build time. It cannot run against a value that
 *        arrived over HTTP. The platform stores an asset key / path, so those
 *        fields are validated here as non-empty strings, and the Astro-side
 *        loader in docs/SITE-INTEGRATION.md replaces image() with z.string()
 *        for API-sourced entries. Both halves are then honest about what they
 *        hold.
 *     b. Identity fields. `slug` and `order` are COLUMNS on content_items,
 *        not keys in `data`. buildValidationInput() merges them in before
 *        validating, so the mirror can require exactly what the site requires.
 *     c. `sourceNotes`. Migration provenance written by the extraction pass.
 *        It defaults to [] on both sides and the CMS never sets it; it is
 *        mirrored so a value carried in from the importer still validates.
 * ============================================================================
 */

export const SITE_SCHEMA_SOURCE = "waca-web/src/content.config.ts";

/* ------------------------------------------------------------------ *
 * Shared helpers — mirrored verbatim from the site.                   *
 * ------------------------------------------------------------------ */

/** Wild Apricot exports write "" for empty. Treat "" and null as absent. */
const blankToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (value) =>
      value === "" || value === null || value === undefined ? undefined : value,
    schema.optional(),
  );

const link = () => z.string().trim().min(1);
const optionalLink = () => blankToUndefined(link());
const text = () => z.string().trim().min(1);
const optionalText = () => blankToUndefined(text());
const sourceNotes = () => z.array(z.string()).default([]);

/**
 * Difference (a): Astro's `image()`. See the header. A CMS asset field holds
 * a storage key or a site-relative path; it is a string here and a string in
 * the API-sourced loader.
 */
const assetPath = () => blankToUndefined(link());

/* ------------------------------------------------------------------ *
 * Vocabularies. These are the values the site's enums accept, kept as  *
 * named constants so the sync test can compare them to the source.     *
 * ------------------------------------------------------------------ */

export const PRESS_TOPICS = [
  "banking",
  "federal",
  "hemp-thc",
  "labor",
  "licensing",
  "public-health",
  "rulemaking",
  "social-equity",
  "taxation",
  "testimony",
  "youth-access",
] as const;

export const PRESS_KINDS = [
  "article",
  "broadcast",
  "op-ed",
  "release",
  "statement",
] as const;

export const RECORD_TYPES = [
  "audio",
  "coalition-letter",
  "comment-letter",
  "infographic",
  "meeting-materials",
  "position",
  "release",
  "report",
  "testimony",
] as const;

export const AUDIO_STATUSES = ["published", "withheld"] as const;

export const AGENDA_KINDS = ["agenda", "statement"] as const;

export const PERSON_GROUPS = ["board", "staff"] as const;

export const BOARD_OFFICES = [
  "president",
  "vice-president",
  "treasurer",
  "secretary",
  "trustee",
  "emeritus",
] as const;

export const BIO_STATUSES = ["published", "pending"] as const;

export const MEMBER_CATEGORIES = [
  "retailer",
  "producer-processor",
  "lab-transport",
  "ancillary",
] as const;

export const LOGO_TREATMENTS = ["mono", "colour"] as const;

/**
 * The enum vocabularies, keyed by the path they occupy in the source file.
 * `scripts/test-cms.ts` reads waca-web/src/content.config.ts and asserts each
 * of these appears there with exactly these members.
 */
export const SITE_SCHEMA_PROVENANCE = {
  source: SITE_SCHEMA_SOURCE,
  enums: {
    "press.kind": PRESS_KINDS,
    "press.topics": PRESS_TOPICS,
    "records.type": RECORD_TYPES,
    "records.audioStatus": AUDIO_STATUSES,
    "agendas.kind": AGENDA_KINDS,
    "people.group": PERSON_GROUPS,
    "people.boardOffice": BOARD_OFFICES,
    "people.bioStatus": BIO_STATUSES,
    "members.category": MEMBER_CATEGORIES,
    "members.logoTreatment": LOGO_TREATMENTS,
  },
} as const;

/* ------------------------------------------------------------------ *
 * people                                                              *
 * ------------------------------------------------------------------ */

const personSchema = z.object({
  name: text(),
  role: text(),
  org: optionalText(),
  group: z.enum(PERSON_GROUPS),
  /** Difference (b): comes from content_items.sort_order. */
  order: z.number().int().nonnegative(),
  boardOffice: z.enum(BOARD_OFFICES).optional(),
  bioStatus: z.enum(BIO_STATUSES).default("published"),
  headshot: assetPath(),
  headshotSource: optionalLink(),
  linkedin: optionalLink(),
  sourceNotes: sourceNotes(),
});

/* ------------------------------------------------------------------ *
 * members                                                             *
 * ------------------------------------------------------------------ */

const memberSchema = z.object({
  name: text(),
  /** Difference (b): comes from content_items.slug. */
  slug: text(),
  category: z.enum(MEMBER_CATEGORIES),
  url: optionalLink(),
  logo: assetPath(),
  logoTreatment: z.enum(LOGO_TREATMENTS).optional(),
  /**
   * Gate for the public directory. Default false so a new record cannot leak
   * an organisation onto the public site by omission — the same default, and
   * the same reason, as the site.
   */
  consentPublicListing: z.boolean().default(false),
});

/* ------------------------------------------------------------------ *
 * press                                                               *
 * ------------------------------------------------------------------ */

const pressSchema = z.object({
  headline: text(),
  date: z.coerce.date(),
  outlet: optionalText(),
  url: optionalLink(),
  asset: assetPath(),
  audio: assetPath(),
  kind: z.enum(PRESS_KINDS),
  topics: z.array(z.enum(PRESS_TOPICS)).default([]),
  featured: z.boolean().default(false),
});

/* ------------------------------------------------------------------ *
 * records — including the accessibility gate, mirrored in full        *
 * ------------------------------------------------------------------ */

const recordSchema = z
  .object({
    title: text(),
    date: z.coerce.date(),
    dateApprox: z.boolean().default(false),
    type: z.enum(RECORD_TYPES),
    document: assetPath(),
    audio: assetPath(),
    audioStatus: z.enum(AUDIO_STATUSES).default("published"),
    transcript: optionalLink(),
    pages: blankToUndefined(z.coerce.number().int().positive()),
    billNumber: optionalText(),
    session: optionalText(),
    sourceUrl: optionalLink(),
  })
  .superRefine((value, ctx) => {
    /**
     * ACCESSIBILITY GATE — WCAG 2.1 SC 1.2.1 (Audio-only, Level A).
     * The site refuses to build an audio record with no text alternative.
     * The CMS refuses to publish one, in the same words, so the staffer who
     * attached the recording is the person who reads the message.
     */
    if (value.audio && !value.transcript && value.audioStatus !== "withheld") {
      ctx.addIssue({
        code: "custom",
        path: ["transcript"],
        message:
          "This record has audio but no transcript. Audio-only content needs a " +
          "text alternative (WCAG 2.1 SC 1.2.1, Level A). Add a transcript, or " +
          "set the audio status to “withheld” — the recording is then catalogued " +
          "but not published as playable media.",
      });
    }

    if (value.audioStatus === "withheld" && value.transcript) {
      ctx.addIssue({
        code: "custom",
        path: ["audioStatus"],
        message:
          "There is a transcript, so “withheld” is stale. Set the audio status " +
          "back to “published” and let people hear it.",
      });
    }

    if (!value.audio && value.audioStatus === "withheld") {
      ctx.addIssue({
        code: "custom",
        path: ["audioStatus"],
        message:
          "Audio status is set but there is no audio file on this record.",
      });
    }
  });

/* ------------------------------------------------------------------ *
 * agendas                                                             *
 * ------------------------------------------------------------------ */

const agendaSchema = z.object({
  year: z.number().int().min(2014).max(2100).optional(),
  title: text(),
  kind: z.enum(AGENDA_KINDS).default("agenda"),
  documents: z
    .array(
      z.object({
        label: text(),
        source: link(),
        status: optionalText(),
      }),
    )
    .default([]),
  relatedRecord: optionalText(),
  sourceUrl: optionalLink(),
});

/* ------------------------------------------------------------------ *
 * posts                                                               *
 * ------------------------------------------------------------------ */

const postSchema = z.object({
  title: text(),
  date: z.coerce.date(),
  datetime: optionalText(),
  author: text().default("WACA"),
  source: optionalLink(),
  sourceId: z.coerce.number().int().positive().optional(),
  attachments: z
    .array(
      z.object({
        label: text(),
        source: link(),
        href: optionalLink(),
      }),
    )
    .default([]),
  image: assetPath(),
  sourceNotes: sourceNotes(),
});

/* ------------------------------------------------------------------ *
 * page — no Astro collection; these become files under src/pages.     *
 *                                                                     *
 * The site has no schema for these, so this one is NOT a mirror: it is *
 * the platform's own contract for what a page needs before it can be   *
 * rendered. It is here so `page` is validated by the same machinery as *
 * everything else rather than being the one collection with no gate.   *
 * ------------------------------------------------------------------ */

const pageSchema = z.object({
  path: z
    .string()
    .trim()
    .min(1)
    .regex(
      /^\/[a-z0-9\-/]*$/,
      "A page path starts with / and contains only lower-case letters, numbers and hyphens.",
    ),
  lede: text(),
  body: text(),
  heroImage: assetPath(),
  metaDescription: blankToUndefined(
    z
      .string()
      .trim()
      .min(1)
      .max(
        160,
        "Google truncates a meta description past about 160 characters.",
      ),
  ),
});

/* ------------------------------------------------------------------ *
 * stat — mirrors waca-web/src/data/stats.yaml, which src/lib/stats.ts  *
 * throws on at build time if a figure has no source.                   *
 * ------------------------------------------------------------------ */

const statSchema = z.object({
  value: text(),
  label: text(),
  sourceId: text(),
  sourceTitle: text(),
  sourceUrl: optionalLink(),
  /**
   * The site prints "as of <year>" beside every figure. A number with no
   * as-of date is a number nobody can date, which is how a 2020 employment
   * figure ends up being read as this year's.
   */
  asOf: z.coerce.date(),
  downloadable: z.boolean().default(false),
});

/* ------------------------------------------------------------------ *
 * nav — mirrors waca-web/src/data/nav.yaml                            *
 * ------------------------------------------------------------------ */

const navLink = z.object({
  label: text(),
  href: text(),
});

const navSchema = z.object({
  primary: z.array(navLink).min(1),
  footer: z.array(navLink).default([]),
});

/* ------------------------------------------------------------------ *
 * setting — mirrors waca-web/src/data/site.yaml, one key per row      *
 * ------------------------------------------------------------------ */

const settingSchema = z.object({
  value: text(),
  note: blankToUndefined(z.string().trim().min(1)),
});

/* ------------------------------------------------------------------ */

export const SITE_SCHEMAS: Record<ContentTypeKey, z.ZodType> = {
  page: pageSchema,
  press: pressSchema,
  record: recordSchema,
  agenda: agendaSchema,
  post: postSchema,
  person: personSchema,
  member: memberSchema,
  stat: statSchema,
  nav: navSchema,
  setting: settingSchema,
};

/**
 * Which Astro collection (or data file) each type feeds. Duplicated from
 * content_types.astro_target so a validation message can name the file that
 * would have failed without another database round trip.
 */
export const SITE_TARGETS: Record<ContentTypeKey, string> = {
  page: "src/pages/**",
  press: "src/content/press",
  record: "src/content/records",
  agenda: "src/content/agendas",
  post: "src/content/posts",
  person: "src/content/people",
  member: "src/content/members",
  stat: "src/data/stats.yaml",
  nav: "src/data/nav.yaml",
  setting: "src/data/site.yaml",
};

/**
 * The key inside `data` that carries the item's headline, per collection.
 * The CMS keeps `title` as a column AND the site's schemas each name their
 * own field, so this is the map between them.
 */
export const TITLE_KEY: Record<ContentTypeKey, string | null> = {
  page: null,
  press: "headline",
  record: "title",
  agenda: "title",
  post: "title",
  person: "name",
  member: "name",
  stat: "label",
  nav: null,
  setting: null,
};

export interface ValidationSubject {
  type: ContentTypeKey;
  title: string;
  slug: string;
  sortOrder: number;
  excerpt?: string | null;
  data: Record<string, unknown>;
}

/**
 * Merge the identity columns into the data payload so the mirror can require
 * exactly what the site requires. See difference (b) in the header.
 *
 * The title fallback matters: a staffer typing a new press item fills in the
 * Headline box, and `content_items.title` is set from it on save. Before that
 * first save the two can disagree by one keystroke, and failing validation on
 * a field the editor cannot see would be maddening.
 */
export function buildValidationInput(
  subject: ValidationSubject,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...subject.data };
  merged.slug = subject.slug;
  merged.order = subject.sortOrder;

  const titleKey = TITLE_KEY[subject.type];
  if (titleKey && (merged[titleKey] === undefined || merged[titleKey] === "")) {
    merged[titleKey] = subject.title;
  }
  return merged;
}
