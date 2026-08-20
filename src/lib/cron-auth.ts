import { timingSafeEqual } from "node:crypto";

/**
 * ===========================================================================
 *  THE CRON GUARD — one implementation.
 *
 *  Three scheduled routes existed with three hand-rolled copies of this
 *  function (`timingSafeEqual` twice, `constantTimeEqual` once), written by
 *  three people who could not see each other's work. They agreed, which is
 *  the dangerous case: nobody would have noticed when one of them stopped
 *  agreeing, and what these routes do is raise invoices, change what is on a
 *  public website, and put mail on the wire to 3,246 people.
 *
 *  So it is one function, and it uses node's own constant-time compare
 *  rather than a fourth hand-rolled loop.
 *
 *  TWO POSTURES, BOTH DELIBERATE:
 *
 *    · CRON_SECRET UNSET  → 503 and the route does nothing. Not "open in
 *      development". A developer who wants to run the sweep sets the
 *      variable; an endpoint that bills members is never reachable by
 *      accident.
 *
 *    · WRONG SECRET → 401, with no detail. It does not say whether the
 *      header or the query parameter was the one that was read.
 *
 *  Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. `?secret=` is
 *  also accepted so the routes can be curl-ed by hand during a migration;
 *  both go through the same comparison.
 * ===========================================================================
 */

/** Constant-time string compare that does not leak length through timing. */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, so the lengths are compared
  // first — a length difference is not a secret worth protecting, the bytes
  // are.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface CronRequest {
  headers: { get(name: string): string | null };
  nextUrl: { searchParams: URLSearchParams };
}

/**
 * Returns a Response to send back when the caller is NOT authorised, and
 * `null` when it is. Callers read it as:
 *
 *     const denied = authoriseCron(request, "email-dispatch", "…");
 *     if (denied) return denied;
 */
export function authoriseCron(
  request: CronRequest,
  /** Appears in the server log line only. */
  job: string,
  /** One sentence saying what this route does, for the refusal log. */
  whatItDoes: string,
): Response | null {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    console.error(
      `[cron:${job}] CRON_SECRET is not set. Refusing to run — this route ` +
        `${whatItDoes}, and must never be open.`,
    );
    return Response.json(
      { ok: false, error: "CRON_SECRET is not configured on this deployment." },
      { status: 503 },
    );
  }

  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const query = request.nextUrl.searchParams.get("secret") ?? "";

  if (secretsMatch(bearer, secret) || secretsMatch(query, secret)) return null;

  return Response.json({ ok: false, error: "Unauthorised" }, { status: 401 });
}
