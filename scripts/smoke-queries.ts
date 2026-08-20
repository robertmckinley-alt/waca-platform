/** Exercises every exported query helper against the seeded database. */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { db, pgClient } from "../src/db";
import {
  PUBLIC_VIEWER,
  getContactPortalData,
  getCouncilDetail,
  getDashboardSummary,
  getDocumentFor,
  getEventDetail,
  getInvoiceDetail,
  getMemberDetail,
  listCouncils,
  listDocumentsFor,
  listEvents,
  listExpiringMemberships,
  listInvoices,
  listMembers,
  listUnappliedPayments,
  viewerFromContact,
} from "../src/db/queries";
import { contacts, users } from "../src/db/schema";
import { eq } from "drizzle-orm";

async function main() {
  const ok = (label: string, v: unknown) => console.log(`  ok  ${label.padEnd(46)} ${v}`);

  console.log("\n--- listMembers");
  const members = await listMembers({ pageSize: 5 });
  ok("listMembers total", members.total);
  ok("first row", `${members.rows[0].displayName} / ${members.rows[0].levelName} / ${members.rows[0].status}`);
  const searched = await listMembers({ search: "Cascade", pageSize: 5 });
  ok("listMembers search=Cascade", searched.total);
  const filtered = await listMembers({ status: ["pending-renewal"], sort: "expiresOn" });
  ok("listMembers status=pending-renewal", filtered.total);
  const councils = await listCouncils();
  const byCouncil = await listMembers({ councilIds: [councils[0].id] });
  ok(`listMembers councilIds=[${councils[0].slug}]`, byCouncil.total);

  console.log("\n--- getMemberDetail");
  const detail = await getMemberDetail(members.rows[0].organizationId);
  ok("contacts", detail!.contacts.length);
  ok("invoices", detail!.invoices.length);
  ok("membershipHistory", detail!.membershipHistory.length);
  ok("balanceDueCents", detail!.balanceDueCents);

  console.log("\n--- listExpiringMemberships");
  const expiring = await listExpiringMemberships({ withinDays: 90 });
  ok("expiring within 90 days", expiring.length);
  const leak = await listExpiringMemberships({ withinDays: 365, autoRenew: false });
  ok("expiring 365d with auto-renew OFF", leak.length);

  console.log("\n--- listEvents (visibility gate)");
  const pub = await listEvents({ viewer: PUBLIC_VIEWER, pageSize: 100 });
  ok("public viewer sees", pub.total);
  ok("...non-public leaked?", pub.rows.filter((r) => r.visibility !== "public").length);

  const [memberUser] = await db.select().from(users).where(eq(users.role, "member")).limit(1);
  const memberViewer = await viewerFromContact(memberUser.contactId, { userId: memberUser.id });
  const memberEvents = await listEvents({ viewer: memberViewer, pageSize: 100 });
  ok("member viewer sees", memberEvents.total);
  ok("...admin-only leaked?", memberEvents.rows.filter((r) => r.visibility === "admin-only").length);

  const [adminUser] = await db.select().from(users).where(eq(users.role, "admin")).limit(1);
  const adminViewer = await viewerFromContact(adminUser.contactId, { userId: adminUser.id, role: "admin" });
  const adminEvents = await listEvents({ viewer: adminViewer, pageSize: 100 });
  ok("admin viewer sees", adminEvents.total);
  const upcoming = await listEvents({ viewer: PUBLIC_VIEWER, upcomingOnly: true });
  ok("upcoming public events", upcoming.total);

  console.log("\n--- getEventDetail");
  const ev = await getEventDetail(adminEvents.rows.find((e) => e.kind === "conference")!.slug, adminViewer);
  ok("ticketTypes", ev!.ticketTypes.length);
  ok("sponsorTiers on paired event", ev!.pairedSponsorshipEvent?.name ?? "-");
  ok("stats", `${ev!.stats.registered} reg / ${ev!.stats.attended} att / ${((ev!.stats.attendanceRate ?? 0) * 100).toFixed(1)}%`);
  const hidden = await db.query.events.findFirst({ where: (e, { eq: q }) => q(e.visibility, "admin-only") });
  const hiddenAsPublic = await getEventDetail(hidden!.slug, PUBLIC_VIEWER);
  ok("admin-only event via PUBLIC_VIEWER", hiddenAsPublic === null ? "null (correct)" : "LEAKED");

  console.log("\n--- listInvoices");
  const inv = await listInvoices({ pageSize: 5, sort: "dueOn" });
  ok("listInvoices total", inv.total);
  const overdue = await listInvoices({ overdueOnly: true });
  ok("overdueOnly", overdue.total);
  const scoped = await listInvoices({ viewer: memberViewer });
  ok("scoped to member's org", scoped.total);
  const invDetail = await getInvoiceDetail(inv.rows[0].id);
  ok("getInvoiceDetail lines", invDetail!.lines.length);
  const unapplied = await listUnappliedPayments();
  ok("listUnappliedPayments", unapplied.total);

  console.log("\n--- getContactPortalData");
  const [bundleAdmin] = await db.select().from(users).where(eq(users.role, "bundle_admin")).limit(1);
  const portal = await getContactPortalData(bundleAdmin.contactId!);
  ok("organization", portal!.organization?.displayName ?? "-");
  ok("membership level", portal!.membership?.level.name ?? "-");
  ok("colleagues (bundle admin)", portal!.colleagues.length);
  ok("councils", portal!.councils.length);
  ok("registrations up/past", `${portal!.upcomingRegistrations.length}/${portal!.pastRegistrations.length}`);
  ok("invoices / balanceDueCents", `${portal!.invoices.length} / ${portal!.balanceDueCents}`);

  console.log("\n--- listDocumentsFor");
  const pubDocs = await listDocumentsFor(PUBLIC_VIEWER, { pageSize: 100 });
  ok("public viewer sees", pubDocs.total);
  ok("...non-public leaked?", pubDocs.rows.filter((d) => d.accessScope !== "public").length);
  const memberDocs = await listDocumentsFor(memberViewer, { pageSize: 100 });
  ok("member viewer sees", memberDocs.total);
  const memberDetailRows = memberDocs.rows.filter((d) => d.category === "detail-report");
  ok("...weekly Detail Reports visible", memberDetailRows.length);
  const staffDocs = await listDocumentsFor(adminViewer, { pageSize: 100 });
  ok("admin viewer sees", staffDocs.total);
  const councilDoc = staffDocs.rows.find((d) => d.accessScope === "council-restricted")!;
  ok("council-restricted doc via PUBLIC_VIEWER", (await getDocumentFor(councilDoc.slug, PUBLIC_VIEWER)) === null ? "null (correct)" : "LEAKED");

  console.log("\n--- councils / dashboard");
  const cd = await getCouncilDetail("retail");
  ok("retail council members", cd!.members.length);
  ok("retail council priorities", cd!.priorities.length);
  const dash = await getDashboardSummary();
  console.log("  " + JSON.stringify(dash));

  await pgClient.end();
  console.log("\nAll query helpers OK.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
