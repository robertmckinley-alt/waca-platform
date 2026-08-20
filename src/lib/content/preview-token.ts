import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * ============================================================================
 *  PREVIEW TOKENS.
 *
 *  /api/content/preview serves DRAFT content — unpublished press releases,
 *  half-written statements, an agenda that has not been agreed. It is the one
 *  endpoint in the CMS that can leak something WACA has not decided to say.
 *
 *  So it has exactly two ways in:
 *    · an authenticated staff session, or
 *    · one of these: a short-lived, signed, scope-bound token.
 *
 *  Signed with AUTH_SECRET (which already signs document download links), so
 *  there is no second secret to rotate. The token carries its own expiry and
 *  scope in the clear and an HMAC over both, so the server verifies it without
 *  a database round trip and without storing anything: nothing to clean up,
 *  nothing to leave behind, and a token that is worthless five minutes later.
 *
 *  Not a session, not a cookie, not a bearer token for anything else. Scope is
 *  one item id, or "*" for a whole-site preview build.
 * ============================================================================
 */

/** Five minutes. Long enough to open a link, short enough not to matter. */
export const PREVIEW_TOKEN_TTL_SECONDS = 300;

/** A build-time preview needs longer than a click-through. Fifteen minutes. */
export const PREVIEW_BUILD_TTL_SECONDS = 900;

export interface PreviewClaims {
  /** A content_items.id, or "*" for everything. */
  scope: string;
  /** Unix seconds. */
  expiresAt: number;
}

function secret(): string {
  const value = process.env.AUTH_SECRET;
  if (!value) {
    throw new Error(
      "AUTH_SECRET is not set. Preview links cannot be signed without it.",
    );
  }
  return value;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function mintPreviewToken(
  scope: string,
  ttlSeconds: number = PREVIEW_TOKEN_TTL_SECONDS,
): string {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${scope}.${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}

export type PreviewVerdict =
  | { valid: true; claims: PreviewClaims }
  | { valid: false; reason: "malformed" | "bad-signature" | "expired" };

export function verifyPreviewToken(token: string | null): PreviewVerdict {
  if (!token) return { valid: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false, reason: "malformed" };

  const [scope, expiryRaw, signature] = parts;
  const expiresAt = Number(expiryRaw);
  if (!scope || !Number.isFinite(expiresAt)) {
    return { valid: false, reason: "malformed" };
  }

  const expected = sign(`${scope}.${expiryRaw}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  // Compare in constant time, and only when the lengths already match —
  // timingSafeEqual throws on a length mismatch, which is itself a signal.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: "bad-signature" };
  }

  // Expiry is checked AFTER the signature. Checking it first would let an
  // unsigned token with a past date be distinguished from a forged one.
  if (expiresAt * 1000 < Date.now()) {
    return { valid: false, reason: "expired" };
  }

  return { valid: true, claims: { scope, expiresAt } };
}

export function previewGrants(claims: PreviewClaims, itemId: string): boolean {
  return claims.scope === "*" || claims.scope === itemId;
}
