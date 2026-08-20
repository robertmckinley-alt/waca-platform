import { auth } from "@/auth";

/**
 * The identity written into audit_log for every admin mutation.
 * `label` is denormalised so the trail survives a user row being deleted.
 */
export interface AdminActor {
  userId: string;
  contactId: string | null;
  label: string;
  role: "admin" | "staff";
}

/**
 * Guard for every admin server action and route handler.
 *
 * The middleware already gates /admin/* to admin|staff, but a server action is
 * a public POST endpoint reachable regardless of which page rendered it, so
 * the check is repeated here. Never remove it.
 */
export async function requireStaff(): Promise<AdminActor> {
  const session = await auth();
  const user = session?.user;
  if (!user || (user.role !== "admin" && user.role !== "staff")) {
    throw new Error("Not authorised: this action requires WACA staff access.");
  }
  return {
    userId: user.id,
    contactId: user.contactId ?? null,
    label: user.name ?? user.email ?? user.id,
    role: user.role,
  };
}

/** True when the caller is a full admin (not merely staff). */
export async function isAdmin(): Promise<boolean> {
  const session = await auth();
  return session?.user?.role === "admin";
}

/**
 * THE staff predicate, in the one form a route can ask without being thrown
 * out of.
 *
 * `requireStaff()` throws, which is right for a mutation and wrong for
 * /api/content/preview, where "not staff" is not a failure — it is the branch
 * that goes on to check the signed preview token. That route had
 * `role === "admin" || role === "staff"` written out inline, which is a second
 * definition of who staff are, and the sort that stays behind when the first
 * one gains a third role.
 */
export async function isStaffSession(): Promise<boolean> {
  const session = await auth();
  const role = session?.user?.role;
  return role === "admin" || role === "staff";
}
