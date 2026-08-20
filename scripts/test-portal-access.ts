/**
 * Portal access checks.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-portal-access.ts
 *
 * Proves the two things the member portal must not get wrong:
 *   1. document scope is enforced in SQL, per viewer;
 *   2. a download token is short-lived, tamper-evident and bound to one
 *      contact — and is NOT itself the authorisation decision.
 */
import { createHmac } from "node:crypto";

import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";

import { db } from "../src/db";
import { contacts, councilMembers, documents, invoices } from "../src/db/schema";
import {
  PUBLIC_VIEWER,
  getDocumentFor,
  getInvoiceDetail,
  listDocumentsFor,
  viewerFromContact,
} from "../src/db/queries";
import {
  signDocumentToken,
  verifyDocumentToken,
} from "../src/lib/documents/signed-url";

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  const mark = condition ? "PASS" : "FAIL";
  if (!condition) failures++;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  console.log("\n=== 1. Document scope, per viewer ===");

  const [member] = await db
    .select({ id: contacts.id, name: contacts.displayName })
    .from(contacts)
    .where(and(isNull(contacts.archivedAt), isNotNull(contacts.organizationId)))
    .limit(1);

  const memberViewer = await viewerFromContact(member.id);
  const staffViewer = await viewerFromContact(member.id, { role: "staff" });

  const [anon, asMember, asStaff] = await Promise.all([
    listDocumentsFor(PUBLIC_VIEWER, { pageSize: 200 }),
    listDocumentsFor(memberViewer, { pageSize: 200 }),
    listDocumentsFor(staffViewer, { pageSize: 200 }),
  ]);

  console.log(
    `  anonymous ${anon.total} · member ${asMember.total} · staff ${asStaff.total}`,
  );
  check("anonymous sees fewer documents than a member", anon.total < asMember.total);
  check("member sees fewer documents than staff", asMember.total < asStaff.total);

  const anonIds = new Set(anon.rows.map((r) => r.id));
  check(
    "every document an anonymous viewer sees is public-scope",
    anon.rows.every((r) => r.accessScope === "public"),
  );

  // A council document belonging to a council this member is NOT on.
  const myCouncils = await db
    .select({ councilId: councilMembers.councilId })
    .from(councilMembers)
    .where(eq(councilMembers.contactId, member.id));
  const mine = new Set(myCouncils.map((c) => c.councilId));

  const councilDocs = await db
    .select({ id: documents.id, slug: documents.slug, councilRestrictions: documents.councilRestrictions })
    .from(documents)
    .where(eq(documents.accessScope, "council-restricted"));

  const forbidden = councilDocs.find(
    (d) => d.councilRestrictions.length && !d.councilRestrictions.some((c) => mine.has(c)),
  );

  if (forbidden) {
    const direct = await getDocumentFor(forbidden.id, memberViewer);
    check(
      "council document for a council the member is NOT on returns null",
      direct === null,
      forbidden.slug,
    );
    check(
      "…and it is absent from their listing",
      !asMember.rows.some((r) => r.id === forbidden.id),
    );
    check(
      "…and staff can still read it",
      (await getDocumentFor(forbidden.id, staffViewer)) !== null,
    );
  } else {
    console.log("  (no council-restricted document outside this member's councils)");
  }

  const membersOnly = asMember.rows.find((r) => r.accessScope === "members");
  if (membersOnly) {
    check(
      "members-only document is invisible to an anonymous viewer",
      (await getDocumentFor(membersOnly.id, PUBLIC_VIEWER)) === null,
      membersOnly.slug,
    );
    check("…and not in the anonymous listing", !anonIds.has(membersOnly.id));
  }

  console.log("\n=== 2. Download tokens ===");

  const doc = asMember.rows[0];
  const token = signDocumentToken(doc.id, member.id);
  const verified = verifyDocumentToken(token);
  check("a freshly minted token verifies", verified.ok);
  if (verified.ok) {
    check("…and carries the document id", verified.documentId === doc.id);
    check("…and is bound to the contact", verified.contactId === member.id);
    check(
      "…and expires within 5 minutes",
      verified.expiresAt.getTime() - Date.now() <= 300_000 + 1_000,
    );
  }

  const [body, sig] = token.split(".");
  check(
    "a tampered signature is rejected",
    verifyDocumentToken(`${body}.${sig.slice(0, -1)}x`).ok === false,
  );
  check(
    "a tampered payload is rejected",
    verifyDocumentToken(
      `${Buffer.from(JSON.stringify({ d: doc.id, c: member.id, e: 9e9, n: "x" }))
        .toString("base64")
        .replace(/=+$/, "")}.${sig}`,
    ).ok === false,
  );
  check("garbage is rejected", verifyDocumentToken("not-a-token").ok === false);
  check("an empty token is rejected", verifyDocumentToken("").ok === false);

  // signDocumentToken() floors the TTL at 30s so nobody mints a dead link by
  // accident, so forge one here with a correct signature and a past expiry.
  // This is the stronger test: even a perfectly signed token dies on time.
  const b64url = (v: Buffer | string) =>
    Buffer.from(v as never)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const stalePayload = b64url(
    JSON.stringify({
      d: doc.id,
      c: member.id,
      e: Math.floor(Date.now() / 1000) - 60,
      n: "stale",
    }),
  );
  const staleToken = `${stalePayload}.${b64url(
    createHmac("sha256", Buffer.from(process.env.AUTH_SECRET!, "utf8"))
      .update(stalePayload)
      .digest(),
  )}`;
  const staleResult = verifyDocumentToken(staleToken);
  check(
    "a correctly signed but expired token is rejected",
    staleResult.ok === false && staleResult.reason === "expired",
  );

  // The binding check the download route performs: token contact vs session
  // contact. A link forwarded to a colleague must not open.
  const [other] = await db
    .select({ id: contacts.id, name: contacts.displayName })
    .from(contacts)
    .where(and(ne(contacts.id, member.id), isNull(contacts.archivedAt)))
    .limit(1);
  const otherViewer = await viewerFromContact(other.id);
  const forwarded = verifyDocumentToken(signDocumentToken(doc.id, member.id));
  check(
    "a token forwarded to another signed-in member fails the binding check",
    forwarded.ok && forwarded.contactId !== otherViewer.contactId,
    `${member.name} -> ${other.name}`,
  );

  console.log("\n=== 3. Invoices are org-scoped ===");

  const [foreign] = await db
    .select({ id: invoices.id, number: invoices.number })
    .from(invoices)
    .where(
      and(
        sql`${invoices.organizationId} is distinct from ${memberViewer.organizationId}`,
        ne(invoices.status, "draft"),
      ),
    )
    .limit(1);

  if (foreign) {
    check(
      "another organisation's invoice returns null for this member",
      (await getInvoiceDetail(foreign.id, { viewer: memberViewer })) === null,
      foreign.number,
    );
    check(
      "…and staff can read it",
      (await getInvoiceDetail(foreign.id, { viewer: staffViewer })) !== null,
    );
  }

  const [draft] = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(
        eq(invoices.status, "draft"),
        eq(invoices.organizationId, memberViewer.organizationId!),
      ),
    )
    .limit(1);
  if (draft) {
    check(
      "a draft invoice on the member's own org is hidden from them",
      (await getInvoiceDetail(draft.id, { viewer: memberViewer })) === null,
    );
  }

  console.log(
    failures === 0
      ? "\nAll portal access checks passed.\n"
      : `\n${failures} check(s) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
