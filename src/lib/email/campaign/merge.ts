import { ORG_NAME } from "@/lib/constants";
import { escapeHtml } from "@/lib/email/client";
import { humanize, formatDate } from "@/lib/format";
import { POSTAL_ADDRESS_ONE_LINE } from "./compliance";

/**
 * ===========================================================================
 *  MERGE FIELDS — and the rule that nobody ever receives "Dear ,".
 *
 *  WACA has 3,246 contacts and 96 members. That ratio is the whole reason
 *  this file is careful: the overwhelming majority of the list has no
 *  membership level, no renewal date and no council seat, so the fields a
 *  newsletter most wants to personalise on are exactly the fields most
 *  recipients do not have.
 *
 *  So EVERY field in MERGE_FIELDS has a fallback, and every fallback is
 *  NON-EMPTY. Not "an optional fallback the author may set" — a fallback that
 *  exists whether or not anybody thought about it. Some resolve through a
 *  chain (`last_name` falls back to the first name, and only then to
 *  "there"), because the natural fallback for a name is another name.
 *
 *  An author may override any fallback inline:
 *
 *      {{first_name}}                     -> "Jane", or "there"
 *      {{first_name|friend}}              -> "Jane", or "friend"
 *      {{membership_level|not yet a member}}
 *
 *  THE ONLY WAY to end up with an empty substitution is to type a token that
 *  is not in this list. That is precisely the case the review gate fails on:
 *  an unknown token has no fallback by definition, and is the thing that
 *  produces "Dear ,". See `unknownTokens()`.
 * ===========================================================================
 */

/* ---------------------------------------------------------- the subject */

/** Everything a merge field may read. One shape, assembled in one place. */
export interface MergeSubject {
  contactId: string | null;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  email: string;
  title: string | null;
  organizationName: string | null;
  organizationCategory: string | null;
  membershipLevel: string | null;
  membershipStatus: string | null;
  renewalDate: Date | string | null;
  memberSince: Date | string | null;
  councils: string[];
}

/** Fields that are about the SEND, not about the person. Always resolvable. */
export interface MergeSystem {
  unsubscribeUrl: string;
  viewInBrowserUrl: string;
  postalAddress: string;
  organizationName: string;
  today: Date;
}

export interface MergeContext {
  /** Null while previewing a campaign that has no sample recipient yet. */
  subject: MergeSubject | null;
  system: MergeSystem;
}

/* ------------------------------------------------------ the field table */

export type MergeFieldGroup = "person" | "organisation" | "membership" | "system";

export interface MergeFieldDef {
  key: string;
  label: string;
  group: MergeFieldGroup;
  /** What it reads, in one line, for the documented list in the composer. */
  source: string;
  /**
   * What a recipient sees when the source is empty. NEVER an empty string:
   * that is the whole point of this table.
   */
  fallback: string;
  /** Shown in the composer's field list so the shape is obvious. */
  example: string;
  resolve: (s: MergeSubject) => string | null;
}

const asDate = (v: Date | string | null): string | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : formatDate(d);
};

const clean = (v: string | null | undefined): string | null => {
  const s = (v ?? "").trim();
  return s.length ? s : null;
};

/**
 * THE documented list. Order is the order the composer shows them in.
 *
 * `fallback` is the literal a recipient sees. Where a field falls back
 * through another field first, `resolve` does the chaining and `fallback` is
 * only the final resort — so the documented string is always true of the
 * worst case.
 */
export const MERGE_FIELDS: readonly MergeFieldDef[] = [
  {
    key: "first_name",
    label: "First name",
    group: "person",
    source: "contacts.first_name",
    fallback: "there",
    example: "Dear {{first_name}},",
    resolve: (s) => clean(s.firstName),
  },
  {
    key: "last_name",
    label: "Last name",
    group: "person",
    source: "contacts.last_name, then the first name",
    fallback: "there",
    example: "Ms {{last_name}}",
    // A surname's natural stand-in is the given name, not a placeholder word.
    resolve: (s) => clean(s.lastName) ?? clean(s.firstName),
  },
  {
    key: "full_name",
    label: "Full name",
    group: "person",
    source: "contacts.display_name, then first + last",
    fallback: "there",
    example: "{{full_name}}",
    resolve: (s) =>
      clean(s.displayName) ??
      clean([s.firstName, s.lastName].filter(Boolean).join(" ")),
  },
  {
    key: "email",
    label: "Email address",
    group: "person",
    source: "contacts.email",
    fallback: "your address on file",
    example: "We are writing to {{email}}.",
    // Never actually empty: resolveAudience() refuses a blank address.
    resolve: (s) => clean(s.email),
  },
  {
    key: "job_title",
    label: "Job title",
    group: "person",
    source: "contacts.title",
    fallback: "colleague",
    example: "as {{job_title}} at {{organization}}",
    resolve: (s) => clean(s.title),
  },
  {
    key: "organization",
    label: "Organisation",
    group: "organisation",
    source: "organizations.display_name",
    fallback: "your organisation",
    example: "everyone at {{organization}}",
    resolve: (s) => clean(s.organizationName),
  },
  {
    key: "organization_category",
    label: "Organisation category",
    group: "organisation",
    source: "organizations.category, humanised",
    fallback: "the cannabis industry",
    example: "for {{organization_category}} operators",
    resolve: (s) =>
      s.organizationCategory ? humanize(s.organizationCategory) : null,
  },
  {
    key: "membership_level",
    label: "Membership level",
    group: "membership",
    source: "membership_levels.name of the current membership",
    fallback: "Non-member",
    example: "Your {{membership_level}} membership",
    resolve: (s) => clean(s.membershipLevel),
  },
  {
    key: "membership_status",
    label: "Membership status",
    group: "membership",
    source: "memberships.status, humanised",
    fallback: "Not a member",
    example: "Status: {{membership_status}}",
    resolve: (s) =>
      s.membershipStatus ? humanize(s.membershipStatus) : null,
  },
  {
    key: "renewal_date",
    label: "Renewal date",
    group: "membership",
    source: "memberships.expires_on",
    fallback: "not applicable",
    example: "renews on {{renewal_date}}",
    resolve: (s) => asDate(s.renewalDate),
  },
  {
    key: "member_since",
    label: "Member since",
    group: "membership",
    source: "organizations.member_since",
    fallback: "not applicable",
    example: "a member since {{member_since}}",
    resolve: (s) => asDate(s.memberSince),
  },
  {
    key: "councils",
    label: "Sector councils",
    group: "membership",
    source: "councils the contact actively sits on",
    fallback: "none yet",
    example: "You sit on: {{councils}}",
    resolve: (s) => (s.councils.length ? s.councils.join(", ") : null),
  },
];

/**
 * System tokens. Separated from MERGE_FIELDS because they never depend on the
 * recipient's record and therefore can never be blank — they need no fallback
 * and offering one would imply they might fail.
 */
export interface SystemFieldDef {
  key: string;
  label: string;
  source: string;
  resolve: (sys: MergeSystem) => string;
}

export const SYSTEM_FIELDS: readonly SystemFieldDef[] = [
  {
    key: "unsubscribe_url",
    label: "Unsubscribe link",
    source: "This recipient's own single-use unsubscribe token",
    resolve: (sys) => sys.unsubscribeUrl,
  },
  {
    key: "view_in_browser_url",
    label: "View in browser",
    source: "Hosted copy of this campaign",
    resolve: (sys) => sys.viewInBrowserUrl,
  },
  {
    key: "postal_address",
    label: "WACA postal address",
    source: "The CAN-SPAM physical address",
    resolve: (sys) => sys.postalAddress,
  },
  {
    key: "waca",
    label: "Association name",
    source: "Washington CannaBusiness Association",
    resolve: (sys) => sys.organizationName,
  },
  {
    key: "today",
    label: "Today's date",
    source: "The date the message is rendered",
    resolve: (sys) => formatDate(sys.today),
  },
];

const FIELD_BY_KEY = new Map(MERGE_FIELDS.map((f) => [f.key, f]));
const SYSTEM_BY_KEY = new Map(SYSTEM_FIELDS.map((f) => [f.key, f]));

export function isKnownToken(key: string): boolean {
  return FIELD_BY_KEY.has(key) || SYSTEM_BY_KEY.has(key);
}

export function mergeFieldDef(key: string): MergeFieldDef | undefined {
  return FIELD_BY_KEY.get(key);
}

/* ------------------------------------------------------------ scanning */

/** `{{ key }}` or `{{ key | inline fallback }}`. Whitespace-tolerant. */
const TOKEN_RE = /\{\{\s*([a-z0-9_]+)\s*(?:\|([^}]*))?\}\}/gi;

export interface ScannedToken {
  raw: string;
  key: string;
  /** The author's inline override, if any. */
  inlineFallback: string | null;
  known: boolean;
  /** What an empty source would actually render as. Null only when unknown. */
  effectiveFallback: string | null;
}

export function scanTokens(...bodies: (string | null | undefined)[]): ScannedToken[] {
  const out: ScannedToken[] = [];
  const seen = new Set<string>();
  for (const body of bodies) {
    if (!body) continue;
    for (const m of body.matchAll(TOKEN_RE)) {
      const raw = m[0];
      if (seen.has(raw)) continue;
      seen.add(raw);
      const key = m[1].toLowerCase();
      const inlineFallback = m[2] === undefined ? null : m[2].trim();
      const field = FIELD_BY_KEY.get(key);
      const system = SYSTEM_BY_KEY.get(key);
      out.push({
        raw,
        key,
        inlineFallback,
        known: Boolean(field || system),
        effectiveFallback: system
          ? null
          : field
            ? inlineFallback && inlineFallback.length
              ? inlineFallback
              : field.fallback
            : null,
      });
    }
  }
  return out;
}

/**
 * THE check the review gate runs.
 *
 * Returns the tokens that would render as nothing at all. By construction
 * that is exactly the set of unknown tokens — every known field carries a
 * non-empty fallback, and an inline override that is itself empty
 * (`{{first_name|}}`) falls back to the field's own default rather than to a
 * blank, which is why an author cannot accidentally opt out of this.
 */
export function unknownTokens(
  ...bodies: (string | null | undefined)[]
): ScannedToken[] {
  return scanTokens(...bodies).filter((t) => !t.known);
}

/* ------------------------------------------------------------ resolving */

export interface ApplyMergeOptions {
  /**
   * ESCAPE EVERY SUBSTITUTED VALUE AS HTML. Pass `true` for the HTML part,
   * `false` (the default) for the plain-text part.
   *
   * This is not paranoia about staff. The values substituted here are CONTACT
   * DATA — names, organisation names, job titles — and contact data arrives
   * from a Wild Apricot import, from a member editing their own profile, and
   * one day from a public application form. A surname of
   * `O'Brien <b>` is a typo; a display name of
   * `<script src=…>` is an attack, and either one, dropped unescaped into a
   * body that is also served as a hosted "view in browser" page, is a stored
   * XSS with a mailing list attached.
   *
   * Escaping happens at SUBSTITUTION, not at authoring, because that is the
   * one place every value passes through no matter which renderer, template
   * or preview called it.
   *
   * NOTE WHAT THIS IS NOT: it does not escape the author's own markup. The
   * body's HTML was already sanitised against an allowlist by the renderer
   * (`sanitizeInlineHtml`). This escapes only what a token expands to.
   */
  escape?: boolean;
}

/**
 * Substitute every token. An unknown token is left VERBATIM rather than
 * silently deleted: if one ever reaches a preview the author sees
 * `{{frst_name}}` sitting in the text, which is a typo they can fix, instead
 * of a hole they will not notice.
 *
 * There is no expression language here and there never will be: a token is
 * `{{key}}` or `{{key|literal fallback}}`, the key is matched against a closed
 * table, and the fallback is used as written. Nothing is evaluated, so there
 * is nothing to inject into.
 */
export function applyMerge(
  body: string,
  ctx: MergeContext,
  opts: ApplyMergeOptions = {},
): string {
  const out = (value: string) => (opts.escape ? escapeHtml(value) : value);

  return body.replace(TOKEN_RE, (raw, rawKey: string, rawFallback?: string) => {
    const key = rawKey.toLowerCase();

    const system = SYSTEM_BY_KEY.get(key);
    if (system) return out(system.resolve(ctx.system));

    const field = FIELD_BY_KEY.get(key);
    if (!field) return raw;

    const inline = rawFallback === undefined ? null : rawFallback.trim();
    const fallback = inline && inline.length ? inline : field.fallback;

    if (!ctx.subject) return out(fallback);
    const resolved = field.resolve(ctx.subject);
    return out(resolved && resolved.trim().length ? resolved : fallback);
  });
}

/** A stand-in subject for previewing a body with nothing merged in yet. */
export const EXAMPLE_SUBJECT: MergeSubject = {
  contactId: null,
  firstName: null,
  lastName: null,
  displayName: null,
  email: "someone@example.org",
  title: null,
  organizationName: null,
  organizationCategory: null,
  membershipLevel: null,
  membershipStatus: null,
  renewalDate: null,
  memberSince: null,
  councils: [],
};

export function defaultSystemFields(
  overrides: Partial<MergeSystem> = {},
): MergeSystem {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return {
    unsubscribeUrl: `${appUrl}/unsubscribe`,
    viewInBrowserUrl: `${appUrl}/email/preview`,
    postalAddress: POSTAL_ADDRESS_ONE_LINE,
    organizationName: ORG_NAME,
    today: new Date(),
    ...overrides,
  };
}
