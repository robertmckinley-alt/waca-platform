import type { Metadata } from "next";
import { Tabs, type TabItem } from "@/components/ui";
import { getEmailCounts } from "@/db/queries";
import { DeliveryModeBanner } from "@/components/email/delivery-banner";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: { default: "Email", template: "%s · Email" } };

/**
 * The email module's shell.
 *
 * The badge on Campaigns counts what is IN FLIGHT — draft, ready, scheduled,
 * sending, paused — rather than everything ever sent. A badge that shows a
 * number nobody has to act on is a badge people learn to ignore.
 */
export default async function EmailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const counts = await getEmailCounts();
  const inFlight =
    counts.campaignsByStatus.draft +
    counts.campaignsByStatus.ready +
    counts.campaignsByStatus.scheduled +
    counts.campaignsByStatus.sending +
    counts.campaignsByStatus.paused;

  const tabs: TabItem[] = [
    { href: "/admin/email", label: "Overview", exact: true },
    {
      href: "/admin/email/campaigns",
      label: "Campaigns",
      badge: inFlight || null,
    },
    { href: "/admin/email/audiences", label: "Audiences", badge: counts.audiences },
    { href: "/admin/email/templates", label: "Templates", badge: counts.templates },
    {
      href: "/admin/email/suppressions",
      label: "Suppressions",
      badge: counts.suppressions,
    },
  ];

  return (
    <>
      <Tabs items={tabs} label="Email sections" className="mb-4" />
      {/* ON THE LAYOUT, not on the pages. Thirteen screens can show a number
          that looks like a delivery; the one that had no banner was the report,
          which is the screen somebody reads AFTER pressing send. Putting it
          here means a new screen cannot be added without it. */}
      <DeliveryModeBanner />
      {children}
    </>
  );
}
