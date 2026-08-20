import { and, eq, isNull, sql } from "drizzle-orm";

import { db as defaultDb, type DbExecutor } from "@/db";
import { councilMembers, councils, contacts, organizations } from "@/db/schema";

/**
 * ===========================================================================
 *  SECTOR COUNCIL AUTO-ENROLMENT
 *
 *  A council declares the licence types that qualify an organisation for it
 *  (`councils.auto_enroll_license_types`). This reconciles the roster against
 *  that rule: every non-archived contact at an organisation holding a
 *  qualifying licence should sit on the council.
 *
 *  Two deliberate asymmetries:
 *
 *   * It ADDS but never deletes. Losing a licence, or a staffer manually
 *     adding someone from a firm that does not hold the licence, must not
 *     silently drop a council chair mid-session. Rows that no longer qualify
 *     are REPORTED as `stale` for a human to act on.
 *   * It never removes a row with `auto_enrolled = false`. A manual add is a
 *     decision; the reconciler does not get to overrule it.
 *
 *  Idempotent: running it twice adds nothing the second time.
 * ===========================================================================
 */

export interface EnrolmentPlan {
  councilId: string;
  councilName: string;
  /** Contacts that qualify but are not on the roster. */
  missing: { contactId: string; organizationId: string; licenseType: string }[];
  /** Auto-enrolled rows whose organisation no longer holds a licence. */
  stale: { contactId: string; contactName: string; organizationName: string }[];
}

/** What auto-enrolment WOULD do. Reads only. */
export async function planAutoEnrolment(
  councilId: string,
  opts: { db?: DbExecutor } = {},
): Promise<EnrolmentPlan | null> {
  const database = opts.db ?? defaultDb;

  const [council] = await database
    .select()
    .from(councils)
    .where(eq(councils.id, councilId))
    .limit(1);
  if (!council) return null;

  const licenceTypes = council.autoEnrollLicenseTypes as string[];
  if (licenceTypes.length === 0) {
    return {
      councilId: council.id,
      councilName: council.name,
      missing: [],
      stale: [],
    };
  }

  const licenceArray = sql`array[${sql.join(
    licenceTypes.map((l) => sql`${l}`),
    sql`, `,
  )}]::license_type[]`;

  const missing = await database
    .select({
      contactId: contacts.id,
      organizationId: organizations.id,
      licenseType: sql<string>`(
        select lt from unnest(${organizations.licenseTypes}) lt
         where lt = any(${licenceArray}) limit 1
      )`,
    })
    .from(contacts)
    .innerJoin(organizations, eq(organizations.id, contacts.organizationId))
    .where(
      and(
        isNull(contacts.archivedAt),
        sql`${organizations.licenseTypes} && ${licenceArray}`,
        sql`not exists (
          select 1 from ${councilMembers} cm
           where cm.council_id = ${council.id}
             and cm.contact_id = ${contacts.id}
             and cm.is_active
        )`,
      ),
    );

  const stale = await database
    .select({
      contactId: contacts.id,
      contactName: contacts.displayName,
      organizationName: organizations.displayName,
    })
    .from(councilMembers)
    .innerJoin(contacts, eq(contacts.id, councilMembers.contactId))
    .leftJoin(organizations, eq(organizations.id, councilMembers.organizationId))
    .where(
      and(
        eq(councilMembers.councilId, council.id),
        eq(councilMembers.isActive, true),
        eq(councilMembers.autoEnrolled, true),
        sql`(${organizations.licenseTypes} is null
             or not (${organizations.licenseTypes} && ${licenceArray}))`,
      ),
    );

  return {
    councilId: council.id,
    councilName: council.name,
    missing: missing as EnrolmentPlan["missing"],
    stale: stale as EnrolmentPlan["stale"],
  };
}

/** Applies the additive half of the plan. Returns how many rows were added. */
export async function applyAutoEnrolment(
  councilId: string,
  opts: { db?: DbExecutor } = {},
): Promise<number> {
  const database = opts.db ?? defaultDb;
  const plan = await planAutoEnrolment(councilId, { db: database });
  if (!plan || plan.missing.length === 0) return 0;

  const today = new Date().toISOString().slice(0, 10);

  await database
    .insert(councilMembers)
    .values(
      plan.missing.map((m) => ({
        councilId,
        contactId: m.contactId,
        organizationId: m.organizationId,
        role: "member" as const,
        autoEnrolled: true,
        enrolledViaLicenseType: (m.licenseType ?? null) as never,
        joinedOn: today,
        isActive: true,
      })),
    )
    // The (council_id, contact_id) unique index is the real guard against a
    // double-click enrolling somebody twice.
    .onConflictDoNothing();

  return plan.missing.length;
}
