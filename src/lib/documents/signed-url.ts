import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { DOCUMENT_URL_TTL_SECONDS } from "@/lib/constants";

/**
 * ============================================================================
 *  SIGNED DOCUMENT LINKS
 *
 *  A member never receives a durable URL to a file. The library page mints a
 *  short-lived, HMAC-signed, viewer-BOUND token per render; the download route
 *  verifies it and then re-runs the database access check before it serves a
 *  single byte.
 *
 *  What the token gives us:
 *    · expiry           — the link dies after DOCUMENT_URL_TTL_SECONDS, so a
 *                         URL pasted into Slack or left in a browser history
 *                         is worthless within minutes.
 *    · viewer binding   — `c` pins the token to one contact id. Forwarding it
 *                         to a colleague fails: the route compares the token's
 *                         contact to the SESSION's contact.
 *    · integrity        — HMAC-SHA256 over the payload with AUTH_SECRET. The
 *                         document id cannot be swapped for a neighbouring one.
 *
 *  What the token does NOT do, deliberately: it is not the authorisation
 *  decision. It is a capability with a fuse on it. Authorisation is always
 *  re-derived from the session and re-checked against the database by
 *  getDocumentFor(id, viewer) at delivery time. A token minted while a member
 *  sat on the Retail council stops working the moment they leave it, without
 *  waiting for the fuse to burn down.
 * ============================================================================
 */

export interface DocumentTokenPayload {
  /** documents.id */
  d: string;
  /** contacts.id the link is bound to; "" for an anonymous public-scope link. */
  c: string;
  /** Expiry, epoch seconds. */
  e: number;
  /** Nonce, so two links minted in the same second are not byte-identical. */
  n: string;
}

export type VerifyResult =
  | { ok: true; documentId: string; contactId: string | null; expiresAt: Date }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" };

function secret(): Buffer {
  const value = process.env.AUTH_SECRET;
  if (!value) {
    // Failing closed is the only safe option: an empty key would make every
    // token forgeable.
    throw new Error(
      "AUTH_SECRET is not set. Document download links cannot be signed.",
    );
  }
  return Buffer.from(value, "utf8");
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input as never)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromB64url(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function sign(body: string): string {
  return b64url(createHmac("sha256", secret()).update(body).digest());
}

/**
 * Mints a download token. Call this on the server, per render — never cache
 * the resulting URL and never hand a `fileKey` to the client.
 */
export function signDocumentToken(
  documentId: string,
  contactId: string | null,
  ttlSeconds: number = DOCUMENT_URL_TTL_SECONDS,
): string {
  const payload: DocumentTokenPayload = {
    d: documentId,
    c: contactId ?? "",
    e: Math.floor(Date.now() / 1000) + Math.max(30, ttlSeconds),
    n: randomBytes(6).toString("hex"),
  };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

export function verifyDocumentToken(token: string | null | undefined): VerifyResult {
  if (!token || token.length > 2048) return { ok: false, reason: "malformed" };

  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    return { ok: false, reason: "malformed" };
  }

  const body = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = sign(body);

  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  // Compare lengths first: timingSafeEqual throws on a length mismatch.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad-signature" };
  }

  let payload: DocumentTokenPayload;
  try {
    payload = JSON.parse(fromB64url(body).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (
    typeof payload?.d !== "string" ||
    typeof payload?.c !== "string" ||
    typeof payload?.e !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }

  if (payload.e * 1000 <= Date.now()) return { ok: false, reason: "expired" };

  return {
    ok: true,
    documentId: payload.d,
    contactId: payload.c === "" ? null : payload.c,
    expiresAt: new Date(payload.e * 1000),
  };
}

/** The href rendered on a download control. Relative, so it works anywhere. */
export function documentDownloadHref(
  documentId: string,
  contactId: string | null,
  ttlSeconds?: number,
): string {
  const token = signDocumentToken(documentId, contactId, ttlSeconds);
  return `/api/documents/${documentId}/download?token=${encodeURIComponent(token)}`;
}
