import { cache } from "react";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import {
  getContactPortalData,
  viewerFromContact,
  type ContactPortalData,
  type Viewer,
  type ViewerRole,
} from "@/db/queries";

/**
 * THE PORTAL'S ONE ENTRY POINT.
 *
 * Every /portal page and every portal server action starts here. The
 * middleware already gates /portal/* to an authenticated user, but a server
 * action is a public POST endpoint reachable regardless of which page rendered
 * it, so the session is resolved again on every call. Never skip it.
 *
 * Wrapped in React's `cache()`: the layout and the page both ask for the
 * context and the database is hit once per request.
 */

export interface PortalContext {
  userId: string;
  email: string;
  role: ViewerRole;
  contactId: string;
  viewer: Viewer;
  data: ContactPortalData;
}

export type PortalState =
  | { status: "ok"; context: PortalContext }
  | { status: "no-session" }
  /** Signed in, but the login is not linked to a contact record yet. */
  | { status: "unlinked"; email: string; role: ViewerRole }
  /** Linked to a contact that has since been archived. */
  | { status: "archived"; email: string };

export const getPortalState = cache(async (): Promise<PortalState> => {
  const session = await auth();
  const user = session?.user;
  if (!user?.id) return { status: "no-session" };

  const role = (user.role ?? "member") as ViewerRole;

  if (!user.contactId) {
    return { status: "unlinked", email: user.email ?? "", role };
  }

  const data = await getContactPortalData(user.contactId);
  if (!data) return { status: "archived", email: user.email ?? "" };

  // getContactPortalData builds a viewer from the contact alone, which floors
  // an admin at "member". Re-derive it with the session role so staff keep
  // staff sight lines when they look at their own portal.
  const viewer =
    role === "admin" || role === "staff"
      ? await viewerFromContact(user.contactId, { userId: user.id, role })
      : { ...data.viewer, userId: user.id };

  return {
    status: "ok",
    context: {
      userId: user.id,
      email: user.email ?? data.contact.email,
      role,
      contactId: user.contactId,
      viewer,
      data,
    },
  };
});

/**
 * Server actions and pages that cannot render anything useful without a member
 * record. Redirects rather than returning a partial context, so a caller can
 * never accidentally proceed with a null contact.
 */
export async function requirePortal(): Promise<PortalContext> {
  const state = await getPortalState();
  if (state.status === "ok") return state.context;
  if (state.status === "no-session") redirect("/login?callbackUrl=%2Fportal");
  redirect("/portal");
}

/** Bundle-admin gate for /portal/organization and its actions. */
export async function requireBundleAdmin(): Promise<
  PortalContext & { organizationId: string }
> {
  const context = await requirePortal();
  const organizationId = context.data.organization?.id;
  const permitted =
    context.data.contact.isBundleAdmin ||
    context.role === "admin" ||
    context.role === "staff";

  if (!permitted || !organizationId) {
    // Not a 403 page: a member who is not a bundle administrator has no
    // business knowing the route exists.
    redirect("/portal");
  }
  return { ...context, organizationId };
}
