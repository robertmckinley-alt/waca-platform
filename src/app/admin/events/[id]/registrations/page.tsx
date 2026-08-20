import { notFound } from "next/navigation";
import { SubmitButton } from "@/components/ui/action-form";
import { FilterBar } from "@/components/ui/filter-bar";
import { Badge, LinkButton, Money, PageHeader } from "@/components/ui/primitives";
import {
  EmptyRow,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableShell,
} from "@/components/ui/table";
import { RegistrationStatusBadge } from "@/components/events/badges";
import { getEventDetail, type RegistrationStatus } from "@/db/queries";
import { setRegistrationStatusAction } from "@/lib/events/actions";
import { listEventRegistrations } from "@/lib/events/admin-queries";
import { REGISTRATION_STATUSES, formatDateTime, humanize } from "@/lib/events/format";
import { requireStaffViewer } from "@/lib/viewer";
import {
  readBool,
  readEnumArray,
  readString,
  toQueryString,
  type RawSearchParams,
} from "@/lib/search-params";

export const dynamic = "force-dynamic";

/** Human-readable rendering of the free-form guest fields. */
function guestDetails(fields: Record<string, unknown>) {
  const entries = Object.entries(fields).filter(
    ([, v]) => v !== null && v !== "" && v !== false,
  );
  if (!entries.length) return <span className="text-zinc-500">—</span>;
  return (
    <ul className="space-y-0.5 text-[11px] text-zinc-600">
      {entries.map(([key, value]) => (
        <li key={key}>
          <span className="text-zinc-500">{humanize(key)}:</span>{" "}
          {typeof value === "boolean" ? "yes" : String(value)}
        </li>
      ))}
    </ul>
  );
}

/** /admin/events/[id]/registrations — the registrant table. */
export default async function EventRegistrationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const viewer = await requireStaffViewer();
  const { id } = await params;
  const sp = await searchParams;

  const status = readEnumArray(sp, "status", REGISTRATION_STATUSES);
  const ticketTypeId = readString(sp, "ticket");
  const search = readString(sp, "q");
  const checkedIn = readBool(sp, "checkedIn");

  const result = await listEventRegistrations(id, viewer, {
    status: status.length ? (status as RegistrationStatus[]) : undefined,
    ticketTypeId,
    search,
    checkedIn,
  });
  if (!result) notFound();

  const { detail, rows } = result;
  const pathname = `/admin/events/${detail.event.id}/registrations`;
  const qs = toQueryString(sp);
  const owed = rows
    .filter((r) => r.status !== "cancelled" && !r.invoicePaid)
    .reduce((sum, r) => sum + r.pricePaidCents, 0);

  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        title="Registrations"
        description={
          <>
            {rows.length} shown · {detail.stats.attended} checked in ·{" "}
            <Money cents={owed} /> outstanding on unpaid invoices
          </>
        }
        actions={
          <>
            <LinkButton href={`/admin/events/${detail.event.id}/checkin`}>
              Check-in screen
            </LinkButton>
            <LinkButton
              href={`${pathname}/export${qs ? `?${qs}` : ""}`}
              variant="primary"
              download
            >
              Export CSV
            </LinkButton>
          </>
        }
      />

      <FilterBar
        pathname={pathname}
        params={sp}
        fields={[
          { kind: "search", name: "q", placeholder: "Name, email or organisation" },
          {
            kind: "multi",
            name: "status",
            label: "Status",
            options: REGISTRATION_STATUSES.map((s) => ({
              value: s,
              label: humanize(s),
            })),
          },
          {
            kind: "select",
            name: "ticket",
            label: "Ticket",
            options: detail.ticketTypes.map((t) => ({ value: t.id, label: t.name })),
          },
          {
            kind: "tristate",
            name: "checkedIn",
            label: "Checked in",
            onLabel: "Checked in",
            offLabel: "Not yet",
          },
        ]}
      />

      <TableShell>
        <Table>
          <THead>
            <TR>
              <TH>Attendee</TH>
              <TH>Organisation</TH>
              <TH>Ticket type</TH>
              <TH>Status</TH>
              <TH align="right">Amount</TH>
              <TH>Paid</TH>
              <TH>Guest details</TH>
              <TH>Checked in</TH>
              <TH />
            </TR>
          </THead>
          <TBody>
            {rows.map((r) => (
              <TR key={r.id}>
                <TD>
                  <span className="font-medium text-zinc-900">{r.attendeeName}</span>
                  <span className="block text-[11px] text-zinc-500">
                    {r.attendeeEmail}
                    {r.attendeeTitle ? ` · ${r.attendeeTitle}` : ""}
                  </span>
                </TD>
                <TD>{r.organizationName ?? "—"}</TD>
                <TD>
                  {r.ticketTypeName}
                  {r.waitlistPosition ? (
                    <span className="block text-[11px] text-zinc-500">
                      waitlist #{r.waitlistPosition}
                    </span>
                  ) : null}
                </TD>
                <TD>
                  <RegistrationStatusBadge status={r.status} />
                </TD>
                <TD align="right">
                  <Money cents={r.pricePaidCents} />
                </TD>
                <TD>
                  {r.invoiceId ? (
                    <Badge tone={r.invoicePaid ? "positive" : "warning"}>
                      {r.invoicePaid ? "Paid" : "Invoiced"}
                    </Badge>
                  ) : (
                    <Badge tone="muted">No invoice</Badge>
                  )}
                </TD>
                <TD>{guestDetails(r.guestFields)}</TD>
                <TD className="whitespace-nowrap text-[11px]">
                  {r.checkedInAt ? formatDateTime(r.checkedInAt) : "—"}
                </TD>
                <TD align="right">
                  <div className="flex justify-end gap-2">
                    {r.status !== "confirmed" && r.status !== "cancelled" ? (
                      <form action={setRegistrationStatusAction}>
                        <input type="hidden" name="eventId" value={detail.event.id} />
                        <input type="hidden" name="registrationId" value={r.id} />
                        <input type="hidden" name="status" value="confirmed" />
                        <SubmitButton variant="secondary">
                          {r.status === "waitlisted" ? "Promote" : "Confirm"}
                        </SubmitButton>
                      </form>
                    ) : null}
                    {r.status !== "cancelled" ? (
                      <form action={setRegistrationStatusAction}>
                        <input type="hidden" name="eventId" value={detail.event.id} />
                        <input type="hidden" name="registrationId" value={r.id} />
                        <input type="hidden" name="status" value="cancelled" />
                        <SubmitButton
                          variant="danger"
                          confirm={`Cancel ${r.attendeeName}'s registration? Any invoice must be voided or refunded separately in finance.`}
                        >
                          Cancel
                        </SubmitButton>
                      </form>
                    ) : null}
                  </div>
                </TD>
              </TR>
            ))}
            {rows.length === 0 ? (
              <EmptyRow colSpan={9}>No registrations match these filters.</EmptyRow>
            ) : null}
          </TBody>
        </Table>
      </TableShell>
    </div>
  );
}
