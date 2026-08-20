import { notFound } from "next/navigation";
import { CloneForm } from "@/components/events/clone-form";
import { getEventDetail } from "@/db/queries";
import { requireStaffViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";

/** Bumps "2026 Annual Conference" to "2027 Annual Conference". */
function bumpYear(name: string): string {
  return name.replace(/(19|20)\d{2}/, (year) => String(Number(year) + 1));
}

function plusOneYear(d: Date): Date {
  const next = new Date(d);
  next.setFullYear(next.getFullYear() + 1);
  return next;
}

/**
 * /admin/events/[id]/clone — WACA runs the same conferences every year, so
 * Wild Apricot's Duplicate button is load-bearing. This is the replacement.
 */
export default async function EventClonePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const viewer = await requireStaffViewer();
  const { id } = await params;
  const detail = await getEventDetail(id, viewer);
  if (!detail) notFound();

  const { event } = detail;

  return (
    <CloneForm
      eventId={event.id}
      suggestedName={bumpYear(event.name)}
      suggestedStart={plusOneYear(event.startsAt)}
      suggestedEnd={event.endsAt ? plusOneYear(event.endsAt) : null}
      hasPairedSponsorship={Boolean(event.pairedSponsorshipEventId)}
      counts={{
        ticketTypes: detail.ticketTypes.length,
        sponsorTiers: detail.sponsorTiers.length,
        sessions: detail.sessions.length,
      }}
    />
  );
}
