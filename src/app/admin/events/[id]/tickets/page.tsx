import { notFound } from "next/navigation";
import { TicketManager } from "@/components/events/ticket-manager";
import { getEventDetail } from "@/db/queries";
import { ticketBreakdownForEvents } from "@/lib/events/admin-queries";
import { requireStaffViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";

/** /admin/events/[id]/tickets — ticket types CRUD with the real presets. */
export default async function EventTicketsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const viewer = await requireStaffViewer();
  const { id } = await params;
  const detail = await getEventDetail(id, viewer);
  if (!detail) notFound();

  const counts = (await ticketBreakdownForEvents([detail.event.id])).get(
    detail.event.id,
  );
  const countBy = new Map((counts ?? []).map((c) => [c.ticketTypeId, c]));

  return (
    <TicketManager
      eventId={detail.event.id}
      tickets={detail.ticketTypes.map((t) => {
        const c = countBy.get(t.id);
        return {
          id: t.id,
          name: t.name,
          description: t.description,
          priceCents: Number(t.priceCents),
          capacity: t.capacity,
          availableFrom: t.availableFrom,
          availableUntil: t.availableUntil,
          memberOnly: t.memberOnly,
          isInternal: t.isInternal,
          isActive: t.isActive,
          minPerOrder: t.minPerOrder,
          maxPerOrder: t.maxPerOrder,
          sortOrder: t.sortOrder,
          pending: c?.pending ?? 0,
          confirmed: c?.confirmed ?? 0,
          waitlisted: c?.waitlisted ?? 0,
          total: c?.total ?? 0,
        };
      })}
    />
  );
}
