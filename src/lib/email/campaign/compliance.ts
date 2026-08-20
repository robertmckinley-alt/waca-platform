import { REMITTANCE, ORG_NAME } from "@/lib/constants";

/**
 * ===========================================================================
 *  CAN-SPAM, AND THE ADVICE THAT IS ONLY ADVICE.
 *
 *  Two very different kinds of rule live in this file and they are kept apart
 *  on purpose.
 *
 *  NON-NEGOTIABLE (15 U.S.C. 7704). Every commercial message WACA sends must
 *  carry a valid physical postal address and a working opt-out mechanism.
 *  Those are not settings, not template options and not something a hurried
 *  staffer can switch off at 4pm on a Friday. The renderer appends both to
 *  every body it produces, and the review gate then RE-READS THE RENDERED
 *  BYTES and fails if either is missing. Belt and braces, deliberately: the
 *  renderer guarantees it, the gate proves it. A campaign whose body was
 *  written by an older renderer, or edited around the application with SQL,
 *  fails the gate rather than quietly going out non-compliant.
 *
 *  ADVICE. Subject length, preheader length and spam-trigger words are
 *  guidance and nothing more. WACA's newsletter runs at roughly a 60% open
 *  rate; the people writing it know their audience better than a word list
 *  does, and a composer that BLOCKS on the word "free" is a composer that
 *  gets worked around. Every function below that returns advice returns it as
 *  advice, and nothing in the send gate consults it.
 * ===========================================================================
 */

/* ------------------------------------------------------ postal address */

/**
 * WACA's registered mailing address, taken from the single REMITTANCE
 * constant rather than restated, so the address on an invoice PDF, in the
 * member portal and in the footer of a newsletter cannot be three different
 * addresses.
 */
export const POSTAL_ADDRESS_LINES: readonly string[] = [
  ORG_NAME,
  ...REMITTANCE.cheque.lines.filter((l) => l !== "WACA"),
];

/** "Washington CannaBusiness Association, PO Box 3329, Kirkland, WA 98033" */
export const POSTAL_ADDRESS_ONE_LINE = POSTAL_ADDRESS_LINES.join(", ");

/**
 * The substring the gate looks for. Deliberately the PO Box and nothing else:
 * a check for the whole one-line string would fail the moment somebody
 * reflows the footer onto two lines, and would then be quietly relaxed.
 */
const POSTAL_ADDRESS_FINGERPRINT = "PO Box 3329";
const POSTAL_CITY_FINGERPRINT = "Kirkland";

export function containsPostalAddress(...bodies: string[]): boolean {
  return bodies.some(
    (b) =>
      b.includes(POSTAL_ADDRESS_FINGERPRINT) &&
      b.includes(POSTAL_CITY_FINGERPRINT),
  );
}

/* -------------------------------------------------------- unsubscribe */

/**
 * The merge token the footer carries. It is replaced per recipient at send
 * time with a link bearing that person's own single-use token; see
 * `issueUnsubscribeToken()` in @/db/queries/email.
 *
 * A campaign body is checked for EITHER the unreplaced token (the state a
 * campaign is in while it sits in the composer) or a rendered /unsubscribe
 * URL (the state a already-dispatched body is in), because the gate has to
 * answer the same question in both.
 */
export const UNSUBSCRIBE_TOKEN = "{{unsubscribe_url}}";
export const UNSUBSCRIBE_PATH = "/unsubscribe";

export function containsUnsubscribeLink(...bodies: string[]): boolean {
  return bodies.some(
    (b) => b.includes(UNSUBSCRIBE_TOKEN) || b.includes(UNSUBSCRIBE_PATH),
  );
}

/* ---------------------------------------------------------- advisories */

export interface Advisory {
  /** Stable key, so a test can assert on one without matching prose. */
  key: string;
  severity: "info" | "warning";
  message: string;
}

const SUBJECT_SWEET_SPOT = { min: 28, max: 60, hardMax: 150 };
const PREHEADER_SWEET_SPOT = { min: 40, max: 100 };

/**
 * Subject-line guidance. iOS Mail truncates around 60 characters in portrait
 * and Gmail on the web around 70; below about 28 a subject stops carrying
 * enough information to earn an open.
 */
export function subjectAdvice(subject: string): Advisory[] {
  const s = subject.trim();
  const out: Advisory[] = [];
  if (!s) return out;
  if (s.length > SUBJECT_SWEET_SPOT.max) {
    out.push({
      key: "subject-long",
      severity: "warning",
      message: `${s.length} characters. Most phones cut the subject off around ${SUBJECT_SWEET_SPOT.max}, so put the point first.`,
    });
  } else if (s.length < SUBJECT_SWEET_SPOT.min) {
    out.push({
      key: "subject-short",
      severity: "info",
      message: `${s.length} characters. Short subjects can read as vague — say what is inside.`,
    });
  } else {
    out.push({
      key: "subject-length-ok",
      severity: "info",
      message: `${s.length} characters — comfortably inside the ${SUBJECT_SWEET_SPOT.min}–${SUBJECT_SWEET_SPOT.max} range most clients show in full.`,
    });
  }
  return out;
}

export function preheaderAdvice(preheader: string | null | undefined): Advisory[] {
  const s = (preheader ?? "").trim();
  if (!s) {
    return [
      {
        key: "preheader-missing",
        severity: "warning",
        message:
          "No preheader. The inbox will show the first words of the body instead, which is usually the view-in-browser link.",
      },
    ];
  }
  if (s.length > PREHEADER_SWEET_SPOT.max) {
    return [
      {
        key: "preheader-long",
        severity: "info",
        message: `${s.length} characters. Anything past about ${PREHEADER_SWEET_SPOT.max} is unlikely to be shown.`,
      },
    ];
  }
  if (s.length < PREHEADER_SWEET_SPOT.min) {
    return [
      {
        key: "preheader-short",
        severity: "info",
        message: `${s.length} characters. There is room for more — the preheader is a second subject line.`,
      },
    ];
  }
  return [
    {
      key: "preheader-ok",
      severity: "info",
      message: `${s.length} characters — a good length.`,
    },
  ];
}

/**
 * Words and shapes that filters weight. This list is short and specific on
 * purpose: a 400-word "spam word" list flags every legitimate association
 * newsletter ever written and teaches staff to ignore the warning entirely.
 */
const TRIGGER_WORDS = [
  "free",
  "act now",
  "limited time",
  "click here",
  "guaranteed",
  "risk free",
  "no obligation",
  "cash bonus",
  "urgent",
  "winner",
  "congratulations",
  "buy now",
  "order now",
  "special promotion",
];

export function spamAdvice(
  subject: string,
  preheader: string | null | undefined,
  textBody: string,
): Advisory[] {
  const out: Advisory[] = [];
  const subjectLine = subject.trim();
  const haystack = `${subjectLine}\n${preheader ?? ""}`.toLowerCase();

  /* ALL CAPS — measured on words of 4+ letters so "WACA", "LCB" and "I-502"
     do not trip it. An acronym is not shouting. */
  const words = subjectLine.split(/\s+/).filter((w) => /[A-Za-z]{4,}/.test(w));
  const shouted = words.filter((w) => w === w.toUpperCase());
  if (words.length > 0 && shouted.length / words.length > 0.4) {
    out.push({
      key: "caps",
      severity: "warning",
      message: `The subject is mostly capitals (${shouted.join(", ")}). Filters score this, and it reads as shouting.`,
    });
  }

  if (/[!?]{2,}/.test(subjectLine) || (subjectLine.match(/!/g) ?? []).length > 1) {
    out.push({
      key: "punctuation",
      severity: "warning",
      message:
        "Repeated exclamation or question marks in the subject. One is plenty.",
    });
  }

  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(subjectLine)) {
    out.push({
      key: "emoji",
      severity: "info",
      message:
        "There is an emoji in the subject. Fine in moderation, but some corporate gateways render it as a box — and much of this list is on corporate mail.",
    });
  }

  const hits = TRIGGER_WORDS.filter((w) => haystack.includes(w));
  if (hits.length) {
    out.push({
      key: "trigger-words",
      severity: "info",
      message: `Words filters weight: ${hits.join(", ")}. Not a problem on its own — worth a second look if this send bounces oddly.`,
    });
  }

  if (/\$\s?\d/.test(subjectLine)) {
    out.push({
      key: "currency",
      severity: "info",
      message: "A dollar figure in the subject line reads as promotional.",
    });
  }

  const linkCount = (textBody.match(/https?:\/\//g) ?? []).length;
  if (linkCount > 25) {
    out.push({
      key: "link-density",
      severity: "warning",
      message: `${linkCount} links in the body. Very high link counts hurt deliverability.`,
    });
  }

  if (!out.length) {
    out.push({
      key: "clean",
      severity: "info",
      message: "Nothing here that a spam filter usually weights.",
    });
  }
  return out;
}
