import Link from "next/link";
import { notFound } from "next/navigation";
import { EventForm } from "@/components/events/event-form";
import { SessionEditor } from "@/components/events/session-editor";
import { SubmitButton } from "@/components/ui/action-form";
import {
  Badge,
  DescList,
  LinkButton,
  Money,
  Panel,
  StatTile,
} from "@/components/ui/primitives";
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
import { getEventDetail, listCouncils } from "@/db/queries";
import { setEventStatusAction } from "@/lib/events/actions";
import { ticketBreakdownForEvents } from "@/lib/events/admin-queries";
import {
  formatRate,
  REGISTRATION_WINDOW_LABELS,
  registrationWindowState,
} from "@/lib/events/format";
import { requireStaffViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";

/** /admin/events/[id] — overview: the numbers, the agenda, the settings. */
export default async function EventOverviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const viewer = await requireStaffViewer();
  const { id } = await params;
  const detail = await getEventDetail(id, viewer);
  if (!detail) notFound();

  const { event, stats, sessions, sponsorTiers, sponsorships } = detail;
  const councils = await listCouncils();
  const tickets = (await ticketBreakdownForEvents([event.id])).get(event.id) ?? [];
  const windowState = registrationWindowState(event);
  const sponsorshipCents = sponsorships
    .filter((s) => s.status !== "cancelled")
    .reduce((sum, s) => sum + Number(s.amountCents), 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Registered" value={stats.registered} />
        <StatTile label="Confirmed" value={stats.confirmed} />
        <StatTile label="Waitlisted" value={stats.waitlisted} />
        <StatTile
          label="Attended"
          value={stats.attended}
          sub={`${formatRate(stats.attendanceRate)} of registered`}
        />
        <StatTile label="Ticket revenue" value={<Money cents={stats.grossCents} />} />
        <StatTile label="Sponsorship" value={<Money cents={sponsorshipCents} />} />
      </div>

      <Panel
        title="Status"
        actions={
          <div className="flex items-center gap-2">
            {event.status !== "published" ? (
              <form action={setEventStatusAction}>
                <input type="hidden" name="id" value={event.id} />
                <input type="hidden" name="status" value="published" />
                <SubmitButton variant="secondary">Publish</SubmitButton>
              </form>
            ) : (
              <form action={setEventStatusAction}>
                <input type="hidden" name="id" value={event.id} />
                <input type="hidden" name="status" value="draft" />
                <SubmitButton
                  variant="secondary"
                  confirm="Unpublish this event? It disappears from every public and member listing."
                >
                  Unpublish
                </SubmitButton>
              </form>
            )}
            {event.status !== "cancelled" ? (
              <form action={setEventStatusAction}>
                <input type="hidden" name="id" value={event.id} />
                <input type="hidden" name="status" value="cancelled" />
                <SubmitButton variant="danger" confirm="Cancel this event?">
                  Cancel event
                </SubmitButton>
              </form>
            ) : null}
          </div>
        }
      >
        <DescList
          columns={3}
          items={[
            {
              label: "Registration",
              value: (
                <Badge
                  tone={
                    windowState === "open"
                      ? "positive"
                      : windowState === "not-yet-open"
                        ? "warning"
                        : "muted"
                  }
                >
                  {REGISTRATION_WINDOW_LABELS[windowState]}
                </Badge>
              ),
            },
            {
              label: "Capacity",
              value:
                event.capacity == null
                  ? "Uncapped"
                  : `${stats.registered} / ${event.capacity}`,
            },
            {
              label: "Waitlist",
              value: event.waitlistEnabled ? "Enabled" : "Off",
            },
            {
              label: "Public page",
              value:
                event.visibility === "public" && event.status === "published" ? (
                  <Link className="underline" href={`/events/${event.slug}`}>
                    /events/{event.slug}
                  </Link>
                ) : (
                  <span className="text-zinc-500">
                    Not publicly listed ({event.visibility})
                  </span>
                ),
            },
            {
              label: "Paired sponsorship event",
              value: detail.pairedSponsorshipEvent ? (
                <Link
                  className="underline"
                  href={`/admin/events/${detail.pairedSponsorshipEvent.id}`}
                >
                  {detail.pairedSponsorshipEvent.name}
                </Link>
              ) : (
                <span className="text-zinc-500">None</span>
              ),
            },
            {
              label: "Council",
              value: detail.council ? detail.council.name : <span className="text-zinc-500">—</span>,
            },
          ]}
        />
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Ticket types"
          bodyClassName="p-0"
          actions={
            <LinkButton href={`/admin/events/${event.id}/tickets`}>Manage</LinkButton>
          }
        >
          <Table>
            <THead>
              <TR>
                <TH>Type</TH>
                <TH align="right">Price</TH>
                <TH align="right">Pending</TH>
                <TH align="right">Confirmed</TH>
                <TH align="right">Total</TH>
              </TR>
            </THead>
            <TBody>
              {tickets.map((t) => (
                <TR key={t.ticketTypeId}>
                  <TD className="text-zinc-900">
                    {t.name}
                    {t.isInternal ? (
                      <span className="ml-1 text-[11px] text-zinc-500">internal</span>
                    ) : null}
                  </TD>
                  <TD align="right">
                    <Money cents={t.priceCents} />
                  </TD>
                  <TD align="right" numeric>
                    {t.pending}
                  </TD>
                  <TD align="right" numeric>
                    {t.confirmed}
                  </TD>
                  <TD align="right" numeric className="font-medium text-zinc-900">
                    {t.total}
                    {t.capacity != null ? (
                      <span className="text-zinc-500">/{t.capacity}</span>
                    ) : null}
                  </TD>
                </TR>
              ))}
              {tickets.length === 0 ? (
                <EmptyRow colSpan={5}>
                  No ticket types yet — add them from the Tickets tab.
                </EmptyRow>
              ) : null}
            </TBody>
          </Table>
        </Panel>

        <Panel
          title="Sponsor tiers"
          bodyClassName="p-0"
          actions={
            <LinkButton href={`/admin/events/${event.id}/sponsors`}>Manage</LinkButton>
          }
        >
          <Table>
            <THead>
              <TR>
                <TH>Tier</TH>
                <TH align="right">Price</TH>
                <TH align="right">Sold</TH>
                <TH align="right">Remaining</TH>
              </TR>
            </THead>
            <TBody>
              {sponsorTiers.map((t) => {
                const sold = sponsorships.filter(
                  (s) => s.sponsorTierId === t.id && s.status !== "cancelled",
                ).length;
                return (
                  <TR key={t.id}>
                    <TD className="text-zinc-900">{t.name}</TD>
                    <TD align="right">
                      <Money cents={Number(t.priceCents)} />
                    </TD>
                    <TD align="right" numeric>
                      {sold}
                    </TD>
                    <TD align="right" numeric>
                      {t.inventory == null ? "∞" : Math.max(0, t.inventory - sold)}
                    </TD>
                  </TR>
                );
              })}
              {sponsorTiers.length === 0 ? (
                <EmptyRow colSpan={4}>No sponsor tiers on this event.</EmptyRow>
              ) : null}
            </TBody>
          </Table>
        </Panel>
      </div>

      <Panel title="Agenda">
        <SessionEditor
          eventId={event.id}
          defaultStart={event.startsAt}
          sessions={sessions.map((s) => ({
            id: s.id,
            title: s.title,
            startsAt: s.startsAt,
            endsAt: s.endsAt,
            room: s.room,
            requiresSignup: s.requiresSignup,
            capacity: s.capacity,
          }))}
        />
      </Panel>

      <Panel title="Settings" bodyClassName="p-3">
        <EventForm
          mode="edit"
          councils={councils.map((c) => ({ id: c.id, name: c.name }))}
          values={{
            id: event.id,
            name: event.name,
            slug: event.slug,
            kind: event.kind,
            status: event.status,
            visibility: event.visibility,
            summary: event.summary ?? "",
            description: event.description ?? "",
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            timezone: event.timezone,
            venueName: event.venueName ?? "",
            venueAddress: event.venueAddress ?? "",
            city: event.city ?? "",
            state: event.state ?? "WA",
            isVirtual: event.isVirtual,
            virtualUrl: event.virtualUrl ?? "",
            capacity: event.capacity,
            registrationOpensAt: event.registrationOpensAt,
            registrationClosesAt: event.registrationClosesAt,
            waitlistEnabled: event.waitlistEnabled,
            councilId: event.councilId,
            contactEmail: event.contactEmail ?? "",
          }}
        />
      </Panel>
    </div>
  );
}
