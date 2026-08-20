import Link from "next/link";
import { auth } from "@/auth";
import { AdminNav, type NavSection } from "@/components/admin/nav";
import { db } from "@/db";
import { membershipApplications } from "@/db/schema";
import { PENDING_APPLICATION_STATUSES } from "@/db/queries";
import { inArray, sql } from "drizzle-orm";
import { APP_NAME, DEMO_DATA_BANNER, IS_DEMO_DATA } from "@/lib/constants";

export const dynamic = "force-dynamic";

/**
 * Admin shell.
 *
 * The middleware already restricts /admin/* to role admin|staff; this layout
 * assumes that and only reads the session for display. Server actions repeat
 * the check with requireStaff() because they are reachable independently.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [session, [pending]] = await Promise.all([
    auth(),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(membershipApplications)
      .where(
        inArray(membershipApplications.status, PENDING_APPLICATION_STATUSES),
      ),
  ]);

  /**
   * THE admin sidebar — one definition, covering the real module set. Sub-pages
   * (a new event, a new invoice, an individual council) are reached from their
   * section's own page, not from the sidebar: a nav that lists every route
   * stops being navigation and becomes a sitemap.
   */
  const sections: NavSection[] = [
    {
      title: "Overview",
      items: [{ href: "/admin", label: "Dashboard", exact: true }],
    },
    {
      title: "People",
      items: [
        { href: "/admin/contacts", label: "Contacts" },
        { href: "/admin/organizations", label: "Organizations" },
      ],
    },
    {
      title: "Membership",
      items: [
        { href: "/admin/members", label: "Members" },
        { href: "/admin/levels", label: "Levels" },
        { href: "/admin/renewals", label: "Renewals" },
        {
          href: "/admin/applications",
          label: "Applications",
          badge: Number(pending?.value ?? 0),
        },
      ],
    },
    {
      title: "Programmes",
      items: [
        { href: "/admin/events", label: "Events" },
        { href: "/admin/documents", label: "Documents" },
        { href: "/admin/councils", label: "Councils" },
      ],
    },
    {
      title: "Money",
      items: [{ href: "/admin/finances", label: "Finances" }],
    },
    {
      title: "System",
      items: [{ href: "/admin/settings", label: "Settings" }],
    },
  ];

  return (
    <div className="flex min-h-screen flex-col">
      {IS_DEMO_DATA ? (
        <div className="border-b border-amber-300 bg-amber-100 px-4 py-1.5 text-center text-[12px] font-medium text-amber-900">
          {DEMO_DATA_BANNER}
        </div>
      ) : null}

      <div className="flex flex-1">
        <aside className="hidden w-56 shrink-0 flex-col justify-between border-r border-zinc-200 bg-zinc-50/60 p-3 md:flex">
          <div>
            <Link href="/admin" className="mb-5 block px-2">
              <span className="text-[13px] font-semibold tracking-tight text-zinc-900">
                {APP_NAME}
              </span>
              <span className="block text-[11px] text-zinc-500">
                Staff back office
              </span>
            </Link>
            <AdminNav sections={sections} />
          </div>

          <div className="border-t border-zinc-200 px-2 pt-3 text-[11px] text-zinc-500">
            <div className="truncate font-medium text-zinc-700">
              {session?.user?.name ?? session?.user?.email ?? "Not signed in"}
            </div>
            <div className="capitalize">{session?.user?.role ?? "—"}</div>
            <Link href="/portal" className="mt-1 block hover:text-zinc-900">
              Member portal →
            </Link>
          </div>
        </aside>

        <main className="min-w-0 flex-1 bg-white p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
