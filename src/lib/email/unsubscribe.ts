import { db as defaultDb, type DbExecutor } from "@/db";
import {
  issueUnsubscribeToken,
  peekUnsubscribeToken,
  redeemUnsubscribeToken,
  type EmailCategory,
  type UnsubscribePeek,
  type UnsubscribeResult,
} from "@/db/queries/email";
import { appUrl } from "./config";
import { undoUnsubscribeToken, type UndoUnsubscribeResult } from "@/db/queries/email-delivery";

/**
 * ===========================================================================
 *  UNSUBSCRIBE — the one link that has to work for somebody who will never
 *  sign in, on a phone, three years from now, on the first click.
 *
 *  THE SHAPE OF THE PATHS
 *
 *    GET  /unsubscribe/<token>          the page. READ ONLY. Shows what the
 *                                       link would do and asks for a click.
 *    POST /unsubscribe/<token>          the form on that page.
 *    POST /api/unsubscribe/<token>      RFC 8058 one-click. The mail client
 *                                       posts here by itself.
 *    GET  /api/unsubscribe/<token>      302 to the page. Never mutates.
 *
 *  WHY GET NEVER UNSUBSCRIBES ANYBODY. Corporate mail gateways and link
 *  scanners pre-fetch every URL in a message. Microsoft Defender for Office
 *  365 does it, Proofpoint does it, Barracuda does it — and a large part of
 *  WACA's list is on corporate mail. A GET that unsubscribed would empty the
 *  list by itself within one send. So the page is a read, and the act is a
 *  POST that a scanner will not issue.
 *
 *  WHY ONE-CLICK IS STILL ONE CLICK. RFC 8058 draws exactly this line: the
 *  mail client POSTs, having decided a human pressed its own Unsubscribe
 *  button, and sends `List-Unsubscribe=One-Click` in the body so the server
 *  can tell that POST from a scanner's. Both routes are wired below and both
 *  end in the same database function.
 *
 *  WHAT A TOKEN-GUESSER LEARNS: nothing. The token is 256 bits and stored
 *  only as sha256; every miss returns the identical "not valid" shape; and a
 *  hit returns a MASKED address (j••••@e••••.org) that tells the holder of
 *  the link only what they already knew. See migration 0007.
 * ===========================================================================
 */

export const UNSUBSCRIBE_PAGE_PATH = "/unsubscribe";
export const UNSUBSCRIBE_ONE_CLICK_PATH = "/api/unsubscribe";

/**
 * How long "Undo" stays available after an unsubscribe.
 *
 * Bounded on purpose. The undo exists so somebody who fat-fingered the link
 * on a phone can put it back without emailing the association — that is a
 * matter of minutes. An unbounded undo would mean a token found in an old
 * mailbox could quietly RE-SUBSCRIBE an address months later, which is the
 * one thing an unsubscribe mechanism must never permit.
 */
export const UNSUBSCRIBE_UNDO_WINDOW_MINUTES = 60;

export function unsubscribePageUrl(token: string): string {
  return `${appUrl()}${UNSUBSCRIBE_PAGE_PATH}/${encodeURIComponent(token)}`;
}

export function oneClickUnsubscribeUrl(token: string): string {
  return `${appUrl()}${UNSUBSCRIBE_ONE_CLICK_PATH}/${encodeURIComponent(token)}`;
}

/* ======================================================================
 *  List-Unsubscribe headers
 * ==================================================================== */

export interface ListHeaderInput {
  /** The recipient's own raw unsubscribe token. */
  token: string;
  /** Used for List-Id, so a mail client can group and filter the list. */
  category: EmailCategory;
  /** Campaign name or newsletter name, for the human-readable List-Id part. */
  listName?: string;
}

/**
 * THE headers Gmail and Yahoo's bulk-sender rules require, and that every
 * modern client uses to draw its own Unsubscribe button next to the sender's
 * name — which is where most people now unsubscribe, rather than scrolling to
 * a footer. A message without these gets marked as spam instead.
 *
 * `mailto:` is included ONLY when EMAIL_UNSUBSCRIBE_MAILTO names a real
 * mailbox somebody reads. Advertising an unattended address is worse than
 * advertising none: the header promises a working opt-out route.
 */
export function listUnsubscribeHeaders(
  input: ListHeaderInput,
): Record<string, string> {
  const https = oneClickUnsubscribeUrl(input.token);
  const mailto = (process.env.EMAIL_UNSUBSCRIBE_MAILTO ?? "").trim();

  const values = [`<${https}>`];
  if (mailto) {
    values.unshift(`<mailto:${mailto}?subject=unsubscribe>`);
  }

  const host = new URL(appUrl()).host;
  return {
    "List-Unsubscribe": values.join(", "),
    // RFC 8058. Without this the client shows a link, not a button.
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    "List-Id": `${input.listName ?? input.category} <${input.category}.${host}>`,
  };
}

/* ======================================================================
 *  Issuing
 * ==================================================================== */

export interface IssuedUnsubscribeLink {
  token: string;
  tokenId: string;
  url: string;
  oneClickUrl: string;
  headers: Record<string, string>;
}

/**
 * Mint one recipient's link, for one message.
 *
 * SCOPE IS ALWAYS 'all'. The footer says "Unsubscribe from WACA email" and a
 * link must do what it says; a token that quietly only removed somebody from
 * one category would be a lie in the one place WACA cannot afford one. The
 * category-scoped variant the schema supports belongs to a preferences page
 * where the person can see what they are choosing between.
 *
 * `campaignId` is recorded on the token so the campaign's unsubscribe count is
 * real and so an unsubscribe can be attributed to the message that caused it.
 */
export async function issueUnsubscribeLink(input: {
  contactId: string;
  campaignId?: string | null;
  category: EmailCategory;
  listName?: string;
  db?: DbExecutor;
}): Promise<IssuedUnsubscribeLink> {
  const { token, id } = await issueUnsubscribeToken({
    contactId: input.contactId,
    scope: "all",
    campaignId: input.campaignId ?? null,
    db: input.db,
  });

  return {
    token,
    tokenId: id,
    url: unsubscribePageUrl(token),
    oneClickUrl: oneClickUnsubscribeUrl(token),
    headers: listUnsubscribeHeaders({
      token,
      category: input.category,
      listName: input.listName,
    }),
  };
}

/* ======================================================================
 *  The public path — thin wrappers, so a route never talks to the database
 *  directly and the three verbs read the same everywhere.
 * ==================================================================== */

/** READ ONLY. Safe from a GET, and safe for a link scanner to pre-fetch. */
export async function peekUnsubscribe(
  token: string,
  opts: { db?: DbExecutor } = {},
): Promise<UnsubscribePeek> {
  return peekUnsubscribeToken(token, opts);
}

/** WRITE. POST only. Idempotent — a double submit reports the same success. */
export async function redeemUnsubscribe(
  token: string,
  opts: { db?: DbExecutor } = {},
): Promise<UnsubscribeResult> {
  return redeemUnsubscribeToken(token, opts);
}

/** WRITE. POST only, and only inside the undo window. */
export async function undoUnsubscribe(
  token: string,
  opts: { db?: DbExecutor; windowMinutes?: number } = {},
): Promise<UndoUnsubscribeResult> {
  return undoUnsubscribeToken(token, {
    db: opts.db ?? defaultDb,
    windowMinutes: opts.windowMinutes ?? UNSUBSCRIBE_UNDO_WINDOW_MINUTES,
  });
}

export type { UnsubscribePeek, UnsubscribeResult, UndoUnsubscribeResult };
