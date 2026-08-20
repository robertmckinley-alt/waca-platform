import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { contacts, councilMembers, memberships } from "@/db/schema";
import {
  PUBLIC_VIEWER,
  type Viewer,
  type ViewerRole,
  type WithExecutor,
} from "./types";

/**
 * Builds a Viewer from a contact id. Use this from server components and
 * route handlers after resolving the session.
 */
export async function viewerFromContact(
  contactId: string | null | undefined,
  opts: WithExecutor & { userId?: string | null; role?: ViewerRole } = {},
): Promise<Viewer> {
  const database = opts.db ?? defaultDb;
  const role: ViewerRole = opts.role ?? "member";

  if (!contactId) {
    return {
      ...PUBLIC_VIEWER,
      userId: opts.userId ?? null,
      role: opts.userId ? role : "public",
    };
  }

  const [contact] = await database
    .select({
      id: contacts.id,
      organizationId: contacts.organizationId,
      isBundleAdmin: contacts.isBundleAdmin,
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  if (!contact) {
    return { ...PUBLIC_VIEWER, userId: opts.userId ?? null };
  }

  const [membership] = contact.organizationId
    ? await database
        .select({
          levelId: memberships.levelId,
          status: memberships.status,
        })
        .from(memberships)
        .where(eq(memberships.organizationId, contact.organizationId))
        .limit(1)
    : [];

  const councils = await database
    .select({ councilId: councilMembers.councilId })
    .from(councilMembers)
    .where(eq(councilMembers.contactId, contact.id));

  const effectiveRole: ViewerRole =
    role === "admin" || role === "staff"
      ? role
      : contact.isBundleAdmin
        ? "bundle_admin"
        : "member";

  return {
    userId: opts.userId ?? null,
    contactId: contact.id,
    organizationId: contact.organizationId,
    role: effectiveRole,
    membershipLevelId: membership?.levelId ?? null,
    membershipStatus: membership?.status ?? null,
    councilIds: councils.map((c) => c.councilId),
  };
}
