/**
 * Read-path smoke test for the ADMIN CORE query helpers.
 *
 *   npx tsx --env-file=.env.local scripts/smoke-admin.ts
 *
 * Touches nothing: every call here is a SELECT. The write paths behind the
 * bulk actions are covered by scripts/smoke-admin-actions.ts, which runs
 * inside a transaction it rolls back.
 */
import {
  listContacts, getContactDetail, getMembershipSummaryByLevel, listMembershipLevels,
  listRenewals, getRenewalRiskSummary, listApplications, getAdminDashboard,
  getFilterOptions, listAuditEntries, listMembers, STAFF_VIEWER, listEvents,
} from "@/db/queries";

async function main() {
  const c = await listContacts({ pageSize: 3, search: "a" });
  console.log("contacts", c.total, c.rows[0]?.displayName, c.rows[0]?.tags, c.rows[0]?.councilNames, c.rows[0]?.membershipStatus);
  const tagged = await listContacts({ tags: ["policy-committee"], pageSize: 2 });
  console.log("tagged", tagged.total);
  const d = await getContactDetail(c.rows[0]!.id);
  console.log("detail", d?.contact.displayName, d?.organization?.displayName, d?.membership?.levelName, d?.invoices.length, d?.registrations.length, d?.councils.length, d?.fieldDefinitions.length);
  const levels = await getMembershipSummaryByLevel();
  console.log("levels", levels.map(l => `${l.levelName}: t${l.total} b${l.bundles} a${l.active} ro${l.renewalOverdue} l${l.lapsed} pn${l.pendingNew} pr${l.pendingRenewal} plc${l.pendingLevelChange} c${l.contacts} $${l.annualDuesCents/100}`).join("\n  "));
  console.log("all levels", (await listMembershipLevels({ includeInactive: true })).length);
  const r = await listRenewals({ pageSize: 5 });
  console.log("renewals", r.total, r.rows[0]);
  console.log("risk", await getRenewalRiskSummary());
  console.log("risk overdue-only", await getRenewalRiskSummary({ overdueOnly: true }));
  const a = await listApplications({ pendingOnly: true, pageSize: 3 });
  console.log("applications", a.total, a.rows[0]);
  const dash = await getAdminDashboard();
  console.log("dash", JSON.stringify({...dash, levels: dash.levels.length}, null, 1));
  const f = await getFilterOptions();
  console.log("filters", f.levels.length, f.councils.length, f.organizations.length, f.tags);
  console.log("audit", (await listAuditEntries({ limit: 3 })).length);
  console.log("members", (await listMembers({ pageSize: 2 })).total);
  console.log("events", (await listEvents({ viewer: STAFF_VIEWER, upcomingOnly: true, pageSize: 5 })).rows.map(e => `${e.name} ${e.registeredCount}/${e.capacity}`));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
