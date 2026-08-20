import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { requireStaff } from "@/lib/admin-auth";
import { recordAudit } from "@/lib/audit";
import { csvCents, csvDate, csvResponse, toCsv } from "@/lib/csv";
import {
  listEventRegistrations,
  type AdminRegistrationRow,
} from "@/lib/events/admin-queries";
import { REGISTRATION_STATUSES } from "@/lib/events/format";
import { requireStaffViewer } from "@/lib/viewer";
import type { RegistrationStatus } from "@/db/queries";

/**
 * CSV of the registrant list, honouring the same filters as the screen.
 * Staff-gated twice: requireStaff() for the actor, and the visibility gate
 * inside listEventRegistrations for the event itself.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireStaff();
  const viewer = await requireStaffViewer();
  const { id } = await params;
  const sp = request.nextUrl.searchParams;

  const statuses = sp
    .getAll("status")
    .flatMap((s) => s.split(","))
    .filter((s): s is RegistrationStatus =>
      (REGISTRATION_STATUSES as readonly string[]).includes(s),
    );
  const checkedInParam = sp.get("checkedIn");

  const result = await listEventRegistrations(id, viewer, {
    status: statuses.length ? statuses : undefined,
    ticketTypeId: sp.get("ticket") ?? undefined,
    search: sp.get("q") ?? undefined,
    checkedIn:
      checkedInParam === "true" ? true : checkedInParam === "false" ? false : undefined,
  });
  if (!result) notFound();

  const csv = toCsv<AdminRegistrationRow>(result.rows, [
    { header: "Name", value: (r) => r.attendeeName },
    { header: "Email", value: (r) => r.attendeeEmail },
    { header: "Title", value: (r) => r.attendeeTitle },
    { header: "Organisation", value: (r) => r.organizationName },
    { header: "Ticket type", value: (r) => r.ticketTypeName },
    { header: "Status", value: (r) => r.status },
    { header: "Amount", value: (r) => csvCents(r.pricePaidCents) },
    { header: "Invoiced", value: (r) => (r.invoiceId ? "yes" : "no") },
    { header: "Invoice paid", value: (r) => (r.invoicePaid ? "yes" : "no") },
    { header: "Waitlist position", value: (r) => r.waitlistPosition },
    {
      header: "Checked in",
      value: (r) => (r.checkedInAt ? r.checkedInAt.toISOString() : ""),
    },
    { header: "Registered on", value: (r) => csvDate(r.registeredAt) },
    {
      header: "Guest details",
      value: (r) =>
        Object.entries(r.guestFields)
          .filter(([, v]) => v !== null && v !== "" && v !== false)
          .map(([k, v]) => `${k}: ${typeof v === "boolean" ? "yes" : String(v)}`)
          .join("; "),
    },
    { header: "Notes", value: (r) => r.notes },
  ]);

  await recordAudit({
    actor,
    action: "export",
    entity: "registrations",
    entityId: result.detail.event.id,
    metadata: { rows: result.rows.length, event: result.detail.event.name },
  });

  const stem = `${result.detail.event.slug}-registrations`;
  return csvResponse(csv, stem);
}
