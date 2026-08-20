import { PageHeader } from "@/components/ui/primitives";
import { BLANK_EVENT, EventForm } from "@/components/events/event-form";
import { listCouncils } from "@/db/queries";
import { requireStaffViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";

/** /admin/events/new — the event builder. */
export default async function NewEventPage() {
  await requireStaffViewer();
  const councils = await listCouncils();

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="New event"
        breadcrumb={[{ label: "Events", href: "/admin/events" }]}
        description="Create the event, then add ticket types and sponsor tiers. A new event starts as a draft — publishing is a separate, deliberate step."
      />
      <EventForm
        mode="create"
        values={BLANK_EVENT}
        councils={councils.map((c) => ({ id: c.id, name: c.name }))}
      />
    </div>
  );
}
