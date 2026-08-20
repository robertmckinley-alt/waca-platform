import { and, asc, eq, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import {
  councilMembers,
  councilPriorities,
  councils,
  contacts,
  organizations,
} from "@/db/schema";
import type { WithExecutor } from "./types";

export interface CouncilListRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  autoEnrollLicenseTypes: string[];
  memberCount: number;
  organizationCount: number;
  isActive: boolean;
  sortOrder: number;
}

export async function listCouncils(
  params: WithExecutor & { includeInactive?: boolean } = {},
): Promise<CouncilListRow[]> {
  const database = params.db ?? defaultDb;

  const rows = await database
    .select({
      id: councils.id,
      name: councils.name,
      slug: councils.slug,
      description: councils.description,
      autoEnrollLicenseTypes: councils.autoEnrollLicenseTypes,
      isActive: councils.isActive,
      sortOrder: councils.sortOrder,
      memberCount: sql<number>`(
        select count(*)::int from ${councilMembers} cm
         where cm.council_id = councils.id and cm.is_active
      )`,
      organizationCount: sql<number>`(
        select count(distinct cm.organization_id)::int from ${councilMembers} cm
         where cm.council_id = councils.id and cm.is_active
      )`,
    })
    .from(councils)
    .where(params.includeInactive ? undefined : eq(councils.isActive, true))
    .orderBy(asc(councils.sortOrder));

  return rows as CouncilListRow[];
}

export interface CouncilDetail {
  council: typeof councils.$inferSelect;
  members: {
    contactId: string;
    contactName: string;
    contactEmail: string;
    organizationId: string | null;
    organizationName: string | null;
    role: string;
    autoEnrolled: boolean;
    joinedOn: string;
  }[];
  priorities: (typeof councilPriorities.$inferSelect)[];
}

export async function getCouncilDetail(
  idOrSlug: string,
  opts: WithExecutor = {},
): Promise<CouncilDetail | null> {
  const database = opts.db ?? defaultDb;
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      idOrSlug,
    );

  const [council] = await database
    .select()
    .from(councils)
    .where(isUuid ? eq(councils.id, idOrSlug) : eq(councils.slug, idOrSlug))
    .limit(1);
  if (!council) return null;

  const [members, priorities] = await Promise.all([
    database
      .select({
        contactId: contacts.id,
        contactName: contacts.displayName,
        contactEmail: contacts.email,
        organizationId: organizations.id,
        organizationName: organizations.displayName,
        role: councilMembers.role,
        autoEnrolled: councilMembers.autoEnrolled,
        joinedOn: councilMembers.joinedOn,
      })
      .from(councilMembers)
      .innerJoin(contacts, eq(contacts.id, councilMembers.contactId))
      .leftJoin(
        organizations,
        eq(organizations.id, councilMembers.organizationId),
      )
      .where(
        and(
          eq(councilMembers.councilId, council.id),
          eq(councilMembers.isActive, true),
        ),
      )
      .orderBy(asc(contacts.lastName)),
    database
      .select()
      .from(councilPriorities)
      .where(eq(councilPriorities.councilId, council.id))
      .orderBy(asc(councilPriorities.rank)),
  ]);

  return { council, members, priorities };
}
