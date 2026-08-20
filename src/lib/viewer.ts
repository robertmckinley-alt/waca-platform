import { auth } from "@/auth";
import {
  PUBLIC_VIEWER,
  viewerFromContact,
  type Viewer,
  type ViewerRole,
} from "@/db/queries";
import { requireStaff } from "@/lib/admin-auth";

/**
 * THE session-derived Viewer. Application-wide, not events-specific — the
 * document library, the portal and the public events API all build one of
 * these. (It used to live at @/lib/events/viewer, which made it look like an
 * events concern and invited a second copy for documents.)
 *
 *
 * Every route that reads events or documents builds one of these and hands it
 * to the query helpers. The helpers — not the components — are what keep a
 * non-public event out of a response, so there is nothing to forget here.
 *
 * An anonymous request gets PUBLIC_VIEWER, which is exactly what the public
 * /events list and /api/events/upcoming want.
 */
export async function getViewer(): Promise<Viewer> {
  const session = await auth();
  const user = session?.user;
  if (!user) return PUBLIC_VIEWER;

  return viewerFromContact(user.contactId, {
    userId: user.id,
    role: (user.role ?? "member") as ViewerRole,
  });
}

/**
 * Staff gate for the /admin/events pages. Delegates the authorisation check to
 * requireStaff() so there is one definition of "staff" in the codebase, then
 * returns the Viewer the query helpers need.
 */
export async function requireStaffViewer(): Promise<Viewer> {
  const actor = await requireStaff();
  return viewerFromContact(actor.contactId, {
    userId: actor.userId,
    role: actor.role,
  });
}

/** The actor id recorded on checked_in_by_user_id and audit rows. */
export async function currentUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}
