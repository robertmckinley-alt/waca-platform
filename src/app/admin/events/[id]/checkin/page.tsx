import { notFound } from "next/navigation";
import { CheckInScreen } from "@/components/events/checkin-screen";
import { listEventRegistrations } from "@/lib/events/admin-queries";
import { requireStaffViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";

/**
 * /admin/events/[id]/checkin — the screen that gets used under pressure.
 * Cancelled registrations are left out; waitlisted people are kept, because
 * the door is exactly where they get let in.
 */
export default async function EventCheckInPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const viewer = await requireStaffViewer();
  const { id } = await params;

  const result = await listEventRegistrations(id, viewer, {
    status: ["pending", "confirmed", "waitlisted"],
  });
  if (!result) notFound();

  return (
    <CheckInScreen
      eventId={result.detail.event.id}
      eventName={result.detail.event.name}
      rows={result.rows.map((r) => {
        const notes = [r.guestFields.dietary_needs, r.guestFields.accessibility_needs]
          .filter((v): v is string => typeof v === "string" && v.length > 0)
          .join(" · ");
        return {
          id: r.id,
          name: r.attendeeName,
          email: r.attendeeEmail,
          organizationName: r.organizationName,
          ticketTypeName: r.ticketTypeName,
          status: r.status,
          checkedIn: r.checkedInAt !== null,
          guestNote: notes || null,
        };
      })}
    />
  );
}
