import type { campaigns, audiences } from "@/db/schema";
import type { AudienceDeductions } from "@/db/queries";
import {
  containsPostalAddress,
  containsUnsubscribeLink,
  preheaderAdvice,
  spamAdvice,
  subjectAdvice,
  type Advisory,
} from "./compliance";
import { collectBlockText, hasContent, imageIssues } from "./blocks";
import { extractHrefs } from "./render";
import { unknownTokens } from "./merge";

/**
 * ===========================================================================
 *  THE REVIEW GATE.
 *
 *  This is the most important file in the email module, and the reason is
 *  arithmetic: WACA's list is 3,246 real people, there is no recall, and a
 *  bad send costs the association its standing with the exact audience it
 *  exists to influence.
 *
 *  NINE BLOCKING CHECKS. Every one of them is a fact about the campaign row
 *  and its rendered bytes, not a claim somebody makes in a text box:
 *
 *    1. subject      a subject line exists
 *    2. text         a non-empty plain-text part exists
 *    3. unsubscribe  a working opt-out link is in BOTH renderings
 *    4. postal       WACA's physical address is in BOTH renderings   [CAN-SPAM]
 *    5. links        every http(s) link actually answers             [network]
 *    6. images       every image carries alt text
 *    7. audience     the audience resolves to more than nobody
 *    8. test         a test of THIS version has been sent
 *    9. merge        no merge token lacks a fallback
 *
 *  THE SAME FUNCTION runs on the review page and inside the approve action.
 *  The page is a rendering of the gate, not a second implementation of it —
 *  so a stale page, a crafted POST, or a second tab cannot approve something
 *  the gate would refuse. Do not add a check to one and not the other.
 *
 *  ADVISORIES (subject length, spam triggers, preheader) are returned
 *  alongside and are NOT consulted by `passed`. They are advice. See the
 *  header of ./compliance for why blocking on them would be worse than
 *  useless.
 * ===========================================================================
 */

export type CheckState = "pass" | "fail" | "warn";

export interface ChecklistItem {
  /** Stable key. Tests assert on this, never on the prose. */
  key: string;
  label: string;
  /** False for items that inform but never stop a send. */
  blocking: boolean;
  state: CheckState;
  /** What was actually found, in plain language. */
  detail: string;
  /** Where to go and fix it. */
  fix?: { label: string; href: string };
}

/* ======================================================================
 *  LINK CHECKING
 * ==================================================================== */

export interface LinkCheck {
  url: string;
  state: CheckState;
  status: number | null;
  note: string;
}

const LINK_TIMEOUT_MS = 8000;
const LINK_CONCURRENCY = 6;
const MAX_LINKS = 60;

function isMergeToken(url: string): boolean {
  return /\{\{[a-z0-9_]+(\|[^}]*)?\}\}/i.test(url);
}

function absolute(url: string): string | null {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  try {
    if (/^https?:\/\//i.test(url)) return new URL(url).toString();
    if (url.startsWith("/")) return new URL(url, base).toString();
    return null;
  } catch {
    return null;
  }
}

async function checkOne(url: string): Promise<LinkCheck> {
  const target = absolute(url);
  if (!target) {
    return {
      url,
      state: "fail",
      status: null,
      note: "Not a URL an email client could open.",
    };
  }

  const attempt = async (method: "HEAD" | "GET"): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LINK_TIMEOUT_MS);
    try {
      return await fetch(target, {
        method,
        redirect: "follow",
        signal: controller.signal,
        headers: { "user-agent": "WACA-link-check/1.0 (+campaign review)" },
        cache: "no-store",
      });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let response = await attempt("HEAD");
    // Plenty of servers answer HEAD with 405 or 501 and are perfectly fine.
    if (response.status === 405 || response.status === 501) {
      response = await attempt("GET");
    }
    const status = response.status;

    if (status < 400) {
      return { url, state: "pass", status, note: `${status}` };
    }
    if ([401, 403, 405, 429].includes(status)) {
      // Reachable, but refusing an automated request. Bot protection is not a
      // broken link, and failing the send over it would train staff to click
      // past this screen — which is the one screen they must never click past.
      return {
        url,
        state: "warn",
        status,
        note: `${status} — the server answered but refused an automated request. Open it yourself before sending.`,
      };
    }
    return {
      url,
      state: "fail",
      status,
      note: `${status} — this link is broken.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = /abort/i.test(message);
    return {
      url,
      state: "fail",
      status: null,
      note: timedOut
        ? `No answer within ${LINK_TIMEOUT_MS / 1000}s.`
        : `Could not be reached: ${message}`,
    };
  }
}

/**
 * HEAD-check every http(s) link in the rendered body. Bounded in three ways —
 * a per-request timeout, a concurrency cap and a total link cap — because
 * this runs inside a page render and a campaign linking to a hung host must
 * not hang the review screen with it.
 */
export async function checkLinks(html: string): Promise<LinkCheck[]> {
  const urls = extractHrefs(html)
    .filter((u) => !isMergeToken(u))
    .filter((u) => !/^(mailto:|tel:|#)/i.test(u))
    .slice(0, MAX_LINKS);

  const results: LinkCheck[] = [];
  for (let i = 0; i < urls.length; i += LINK_CONCURRENCY) {
    const batch = urls.slice(i, i + LINK_CONCURRENCY);
    results.push(...(await Promise.all(batch.map(checkOne))));
  }
  return results;
}

/* ======================================================================
 *  THE RECIPIENT NARRATIVE
 * ==================================================================== */

export interface RecipientNarrative {
  matched: number;
  afterSuppressions: number;
  afterBounces: number;
  /** THE number. What the approver has to type back. */
  finalCount: number;
  optedOut: number;
  /** Full sentence, ready to render. */
  sentence: string;
  steps: { label: string; value: number; delta: number | null }[];
}

const n = (v: number) => v.toLocaleString("en-US");

/**
 * "3,246 contacts → 3,180 after suppressions → 3,174 after bounces. This will
 * send to 3,174 people."
 *
 * Bounces are broken out of the suppression total rather than folded into it
 * because they are the deduction staff are least aware of and most need to
 * see: an unsubscribe is a decision somebody made, a bounce is an address
 * quietly rotting, and 3,150 of these contacts are WACA's membership
 * pipeline.
 */
export function recipientNarrative(
  d: AudienceDeductions,
  actualRecipientCount: number | null,
): RecipientNarrative {
  const nonBounce = d.unsubscribed + d.complained + d.manual;
  const afterSuppressions = d.matched - nonBounce;
  const afterBounces = afterSuppressions - d.bounced;
  const finalCount = actualRecipientCount ?? d.mailable;

  const steps = [
    { label: "matched by this audience", value: d.matched, delta: null },
    {
      label: "after unsubscribes, complaints and manual suppressions",
      value: afterSuppressions,
      delta: -nonBounce,
    },
    { label: "after bounced addresses", value: afterBounces, delta: -d.bounced },
  ];
  if (finalCount !== afterBounces) {
    steps.push({
      label: "on the built recipient list",
      value: finalCount,
      delta: finalCount - afterBounces,
    });
  }

  const sentence =
    `${n(d.matched)} contacts → ${n(afterSuppressions)} after suppressions → ` +
    `${n(afterBounces)} after bounces. This will send to ${n(finalCount)} ` +
    `${finalCount === 1 ? "person" : "people"}.`;

  return {
    matched: d.matched,
    afterSuppressions,
    afterBounces,
    finalCount,
    optedOut: d.optedOut,
    sentence,
    steps,
  };
}

/* ======================================================================
 *  THE GATE
 * ==================================================================== */

export interface ReviewInput {
  campaign: typeof campaigns.$inferSelect;
  audience: typeof audiences.$inferSelect | null;
  deductions: AudienceDeductions;
  /** From buildRecipients(); null when the list has not been built. */
  builtRecipientCount: number | null;
  /**
   * Pre-computed link results. Passed in rather than fetched here so a page
   * and the approve action can share one round of network calls, and so a
   * test can drive the gate without a network.
   */
  linkChecks: LinkCheck[];
  /**
   * True when this deployment transmits nothing (no API key, EMAIL_DRY_RUN, or
   * demo data). Passed in rather than read here so the checklist stays a pure
   * function of its inputs and a test can drive both modes.
   *
   * It changes ONE thing: the wording of the test-send check, which must not
   * say "sent to" about a message that was never sent. It does not relax any
   * check, and `passed` is computed identically either way.
   */
  dryRun?: boolean;
}

export interface ReviewResult {
  items: ChecklistItem[];
  advisories: Advisory[];
  linkChecks: LinkCheck[];
  recipients: RecipientNarrative;
  /** True when every BLOCKING item passed. Warnings do not count. */
  passed: boolean;
  blockingFailures: ChecklistItem[];
}

export function runReview(input: ReviewInput): ReviewResult {
  const { campaign, audience, deductions, builtRecipientCount, linkChecks } =
    input;
  const base = `/admin/email/campaigns/${campaign.id}`;
  const items: ChecklistItem[] = [];

  /* 1 — subject ------------------------------------------------------- */
  const subject = campaign.subject.trim();
  items.push({
    key: "subject",
    label: "Subject line present",
    blocking: true,
    state: subject ? "pass" : "fail",
    detail: subject ? `“${subject}”` : "This campaign has no subject line.",
    fix: subject ? undefined : { label: "Write a subject", href: base },
  });

  /* 2 — plain text ---------------------------------------------------- */
  const text = campaign.textBody.trim();
  const bodyHasContent = hasContent(campaign.blocks);
  items.push({
    key: "text",
    label: "Plain-text part present",
    blocking: true,
    state: text && bodyHasContent ? "pass" : "fail",
    detail:
      text && bodyHasContent
        ? `${text.length.toLocaleString("en-US")} characters, rendered from the same blocks as the HTML.`
        : !bodyHasContent
          ? "The body is empty, so there is nothing to render."
          : "No plain-text part. Re-save the body to render one.",
    fix:
      text && bodyHasContent
        ? undefined
        : { label: "Open the builder", href: base },
  });

  /* 3 — unsubscribe --------------------------------------------------- */
  const hasUnsub = containsUnsubscribeLink(campaign.htmlBody, campaign.textBody);
  items.push({
    key: "unsubscribe",
    label: "Working unsubscribe link",
    blocking: true,
    state: hasUnsub ? "pass" : "fail",
    detail: hasUnsub
      ? "Present in both the HTML and the plain-text part. Each recipient gets their own single-use token."
      : "No unsubscribe link in the rendered body. CAN-SPAM requires one and this campaign cannot be sent without it.",
    fix: hasUnsub ? undefined : { label: "Re-render the body", href: base },
  });

  /* 4 — postal address ------------------------------------------------ */
  const hasPostal = containsPostalAddress(campaign.htmlBody, campaign.textBody);
  items.push({
    key: "postal",
    label: "Physical postal address",
    blocking: true,
    state: hasPostal ? "pass" : "fail",
    detail: hasPostal
      ? "PO Box 3329, Kirkland, WA 98033 appears in both renderings."
      : "No physical address in the rendered body. CAN-SPAM requires one.",
    fix: hasPostal ? undefined : { label: "Re-render the body", href: base },
  });

  /* 5 — links --------------------------------------------------------- */
  const brokenLinks = linkChecks.filter((l) => l.state === "fail");
  const warnLinks = linkChecks.filter((l) => l.state === "warn");
  items.push({
    key: "links",
    label: "Every link resolves",
    blocking: true,
    state: brokenLinks.length ? "fail" : warnLinks.length ? "warn" : "pass",
    detail: !linkChecks.length
      ? "No links in this campaign to check."
      : brokenLinks.length
        ? `${brokenLinks.length} of ${linkChecks.length} did not resolve: ${brokenLinks
            .map((l) => l.url)
            .slice(0, 3)
            .join(", ")}${brokenLinks.length > 3 ? "…" : ""}`
        : warnLinks.length
          ? `${linkChecks.length} checked. ${warnLinks.length} answered but refused an automated request — open those yourself.`
          : `All ${linkChecks.length} checked and answered.`,
    fix: brokenLinks.length ? { label: "Fix the links", href: base } : undefined,
  });

  /* 6 — image alt text ------------------------------------------------ */
  const badImages = imageIssues(campaign.blocks);
  items.push({
    key: "images",
    label: "Every image has alt text",
    blocking: true,
    state: badImages.length ? "fail" : "pass",
    detail: badImages.length
      ? badImages.map((i) => i.hint).join(" ")
      : "Checked. Alt text is what a screen reader announces and what the plain-text part prints in place of the picture.",
    fix: badImages.length ? { label: "Add alt text", href: base } : undefined,
  });

  /* 7 — audience ------------------------------------------------------ */
  const built = builtRecipientCount ?? 0;
  items.push({
    key: "audience",
    label: "Audience resolves to somebody",
    blocking: true,
    state: !audience ? "fail" : built > 0 ? "pass" : "fail",
    detail: !audience
      ? "No audience is selected."
      : built > 0
        ? `“${audience.name}” — ${n(built)} recipients on the built list.`
        : deductions.matched > 0
          ? `“${audience.name}” matches ${n(deductions.matched)} contacts but the recipient list has not been built, or every match is suppressed.`
          : `“${audience.name}” matches nobody.`,
    fix:
      !audience || built === 0
        ? { label: "Choose an audience", href: base }
        : undefined,
  });

  /* 8 — test send ----------------------------------------------------- */
  const tested = Boolean(campaign.testSentAt);
  items.push({
    key: "test",
    label: "A test send has been performed",
    blocking: true,
    state: tested ? "pass" : "fail",
    detail: tested
      ? input.dryRun
        ? `Rehearsed for ${campaign.testSentTo ?? "a staff address"} on ${campaign.testSentAt!.toLocaleString("en-US")} — THIS DEPLOYMENT TRANSMITS NOTHING, so the message was rendered and logged, not delivered. Read it in the server log, or on a deployment that sends. Cleared automatically if the subject, body or audience changes.`
        : `Sent to ${campaign.testSentTo ?? "a staff address"} on ${campaign.testSentAt!.toLocaleString("en-US")}. Cleared automatically if the subject, body or audience changes.`
      : "Nobody has sent themselves a copy of this version. Send one and read it on a phone.",
    fix: tested
      ? undefined
      : { label: "Send a test", href: `${base}/preview` },
  });

  /* 9 — merge fallbacks ----------------------------------------------- */
  const unknown = unknownTokens(
    campaign.subject,
    campaign.preheader,
    collectBlockText(campaign.blocks),
  );
  items.push({
    key: "merge",
    label: "No merge field lacks a fallback",
    blocking: true,
    state: unknown.length ? "fail" : "pass",
    detail: unknown.length
      ? `${unknown.map((t) => t.raw).join(", ")} ${unknown.length === 1 ? "is not a" : "are not"} known merge field${unknown.length === 1 ? "" : "s"}, so ${unknown.length === 1 ? "it has" : "they have"} no fallback and would render as nothing.`
      : "Every merge field in this campaign resolves, and every one has a non-empty fallback.",
    fix: unknown.length ? { label: "Fix the merge fields", href: base } : undefined,
  });

  /* --- non-blocking, informational ------------------------------------ */
  items.push({
    key: "from",
    label: "From address",
    blocking: false,
    state: campaign.fromEmail.trim() ? "pass" : "warn",
    detail: campaign.fromEmail.trim()
      ? `${campaign.fromName} <${campaign.fromEmail}>${campaign.replyTo ? `, replies to ${campaign.replyTo}` : ""}`
      : "No from address.",
  });

  const advisories = [
    ...subjectAdvice(campaign.subject),
    ...preheaderAdvice(campaign.preheader),
    ...spamAdvice(campaign.subject, campaign.preheader, campaign.textBody),
  ];

  const blockingFailures = items.filter(
    (i) => i.blocking && i.state === "fail",
  );

  return {
    items,
    advisories,
    linkChecks,
    recipients: recipientNarrative(deductions, builtRecipientCount),
    passed: blockingFailures.length === 0,
    blockingFailures,
  };
}
