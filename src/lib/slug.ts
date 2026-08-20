/**
 * ===========================================================================
 *  THE SLUGIFIER — one implementation.
 *
 *  There were four, in four files, written months and agents apart: the
 *  events module's, the document admin's, the CMS field helpers', and the
 *  seed's. They mostly agreed. "Mostly" is the problem: `slugify("S.B. 5367")`
 *  gave "sb-5367" in one of them and "s-b-5367" in another, and both of those
 *  end up in a URL somebody bookmarks.
 *
 *  THE RULES, stated once:
 *    · lower case
 *    · NFKD, then strip combining marks, so "Peña" is "pena" and not "pea"
 *    · every run of anything that is not [a-z0-9] becomes a single "-"
 *    · no leading or trailing "-"
 *    · truncated to `maxLength`, then re-trimmed, so a cut never lands on a
 *      dash and leaves "waca-detail-report-" in an address bar
 *
 *  It returns "" for input that has no slug in it at all ("...", "###").
 *  Callers decide the fallback, because the right fallback is "event",
 *  "document" or "untitled" depending on who is asking — that is not a
 *  decision this function can make.
 * ===========================================================================
 */

/** The shape every slug in this application matches. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugify(input: string, maxLength = 160): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}

/** True when `value` is already a well-formed slug. */
export function isSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}
