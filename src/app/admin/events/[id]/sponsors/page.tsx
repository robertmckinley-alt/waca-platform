import { notFound } from "next/navigation";
import { SponsorManager } from "@/components/events/sponsor-manager";
import { getEventDetail } from "@/db/queries";
import { listSponsorTiersWithSales } from "@/lib/events/admin-queries";
import { requireStaffViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";

/**
 * /admin/events/[id]/sponsors — sponsor tiers CRUD, sold vs remaining.
 * On a conference, tiers usually live on the paired sponsorship event; this
 * tab manages whichever event you are looking at.
 */
export default async function EventSponsorsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const viewer = await requireStaffViewer();
  const { id } = await params;
  const detail = await getEventDetail(id, viewer);
  if (!detail) notFound();

  const tiers = await listSponsorTiersWithSales(detail.event.id);
  return <SponsorManager eventId={detail.event.id} tiers={tiers} />;
}
