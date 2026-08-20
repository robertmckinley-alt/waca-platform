import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { EventTabs } from "@/components/events/event-tabs";
import { EventVisibilityBadge } from "@/components/events/badges";
import { Badge, PageHeader } from "@/components/ui/primitives";
import { getEventDetail } from "@/db/queries";
import {
  EVENT_KIND_LABELS,
  formatDateRange,
  formatRate,
  humanize,
} from "@/lib/events/format";
import { requireStaffViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";

/**
 * Shell for a single event: header + tabs.
 *
 * Every child tab re-reads through getEventDetail with its own viewer, so this
 * layout is a convenience, never a trust boundary.
 */
export default async function AdminEventLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const viewer = await requireStaffViewer();
  const { id } = await params;
  const detail = await getEventDetail(id, viewer);
  if (!detail) notFound();

  const { event, stats } = detail;

  return (
    <>
      <PageHeader
        title={event.name}
        breadcrumb={[{ label: "Events", href: "/admin/events" }]}
        description={
          <>
            {EVENT_KIND_LABELS[event.kind]} · {formatDateRange(event.startsAt, event.endsAt)} ·{" "}
            {stats.registered} registered · {stats.attended} attended (
            {formatRate(stats.attendanceRate)})
          </>
        }
        actions={
          <>
            <EventVisibilityBadge visibility={event.visibility} />
            <Badge tone={event.status === "published" ? "neutral" : "muted"}>
              {humanize(event.status)}
            </Badge>
          </>
        }
      />
      <EventTabs eventId={event.id} />
      <div className="mt-4">{children}</div>
    </>
  );
}
