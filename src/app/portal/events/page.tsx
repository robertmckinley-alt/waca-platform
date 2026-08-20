import Link from "next/link";

import {
  ActionLink,
  Amount,
  EmptyState,
  Facts,
  PageIntro,
  Pill,
  Row,
  Rows,
  Section,
  statusTone,
} from "@/components/portal/ui";
import { getEventDetail, listEvents } from "@/db/queries";
import {
  EVENT_KIND_LABELS,
  formatDateRange,
  formatEventTime,
  registrationWindowState,
} from "@/lib/events/format";
import { formatDate, humanize, percent } from "@/lib/format";
import { requirePortal } from "@/lib/portal/session";

export const metadata = { title: "Events" };
export const dynamic = "force-dynamic";

/**
 * YOUR EVENTS.
 *
 * Upcoming registrations first, with the things you actually need on the day —
 * when, where, which ticket, whether you are confirmed or waitlisted, and the
 * joining link for a webinar. Then what is open to you. Then your history.
 *
 * Every event on this page arrives through listEvents/getEventDetail with the
 * viewer attached, so an invite-only briefing shows up only for someone
 * actually registered and an admin-only fundraiser never appears at all.
 */
export default async function PortalEventsPage() {
  const { data, viewer } = await requirePortal();

  const upcoming = [...data.upcomingRegistrations]
    .filter((registration) => registration.status !== "cancelled")
    .sort((a, b) => a.eventStartsAt.getTime() - b.eventStartsAt.getTime());

  const past = [...data.pastRegistrations].sort(
    (a, b) => b.eventStartsAt.getTime() - a.eventStartsAt.getTime(),
  );

  const [details, openEvents] = await Promise.all([
    Promise.all(
      upcoming.slice(0, 8).map((registration) =>
        getEventDetail(registration.eventId, viewer),
      ),
    ),
    listEvents({
      viewer,
      upcomingOnly: true,
      sort: "startsAt",
      direction: "asc",
      pageSize: 12,
    }),
  ]);

  const detailByEventId = new Map(
    details.filter((d) => d !== null).map((d) => [d.event.id, d]),
  );

  const registeredEventIds = new Set(
    [...upcoming, ...past].map((registration) => registration.eventId),
  );

  const openForRegistration = openEvents.rows.filter(
    (event) =>
      !registeredEventIds.has(event.id) &&
      event.kind !== "sponsorship" &&
      registrationWindowState(event) === "open",
  );

  const attended = past.filter((r) => r.checkedInAt).length;
  const attendable = past.filter((r) => r.status !== "cancelled").length;

  return (
    <>
      <PageIntro
        eyebrow="Events"
        title="Your events"
        lede="Conferences, Day on the Hill, sector council meetings, member meetings, webinars and workshops. What you are booked on, what is open to you, and where you have been."
      />

      <div className="flex flex-col gap-12">
        <Section title="Coming up">
          {upcoming.length ? (
            <Rows>
              {upcoming.map((registration) => {
                const detail = detailByEventId.get(registration.eventId);
                const event = detail?.event;
                return (
                  <Row key={registration.id} className="py-6">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                      <h3 className="font-serif text-[20px] leading-snug text-zinc-900">
                        <Link
                          href={`/events/${registration.eventSlug}`}
                          className="portal-link"
                        >
                          {registration.eventName}
                        </Link>
                      </h3>
                      <Pill tone={statusTone(registration.status)}>
                        {registration.status === "waitlisted"
                          ? `Waitlisted${registration.waitlistPosition ? ` · position ${registration.waitlistPosition}` : ""}`
                          : humanize(registration.status)}
                      </Pill>
                    </div>

                    <div className="mt-4">
                      <Facts
                        items={[
                          {
                            label: "When",
                            value: event
                              ? formatDateRange(event.startsAt, event.endsAt)
                              : formatDate(registration.eventStartsAt),
                            hint: event
                              ? `Doors ${formatEventTime(event.startsAt)} Pacific`
                              : undefined,
                          },
                          {
                            label: "Where",
                            value: event?.isVirtual
                              ? "Online"
                              : ([event?.venueName, event?.venueAddress, event?.city, event?.state]
                                  .filter(Boolean)
                                  .join(", ") || "To be confirmed"),
                            hint:
                              event?.isVirtual && event.virtualUrl ? (
                                <a className="portal-link" href={event.virtualUrl}>
                                  Joining link
                                </a>
                              ) : undefined,
                          },
                          {
                            label: "Ticket",
                            value: registration.ticketTypeName,
                            hint:
                              registration.pricePaidCents > 0 ? (
                                <>
                                  <Amount cents={registration.pricePaidCents} />{" "}
                                  {registration.invoiceId ? (
                                    <Link
                                      href={`/portal/invoices/${registration.invoiceId}`}
                                      className="portal-link"
                                    >
                                      · invoice
                                    </Link>
                                  ) : null}
                                </>
                              ) : (
                                "No charge"
                              ),
                          },
                          {
                            label: "Registered as",
                            value: registration.attendeeName,
                            hint: registration.attendeeEmail,
                          },
                          ...(event?.contactEmail
                            ? [
                                {
                                  label: "Questions",
                                  value: (
                                    <a
                                      className="portal-link"
                                      href={`mailto:${event.contactEmail}`}
                                    >
                                      {event.contactEmail}
                                    </a>
                                  ),
                                },
                              ]
                            : []),
                        ]}
                      />
                    </div>

                    {registration.status === "waitlisted" ? (
                      <p className="portal-copy mt-3 text-[14px] text-zinc-600">
                        You are on the waitlist. WACA staff will email you if a
                        place opens, and nothing is invoiced unless it does.
                      </p>
                    ) : null}
                  </Row>
                );
              })}
            </Rows>
          ) : (
            <EmptyState title="You are not booked on anything yet.">
              <p>
                Member registrations are free or discounted at most WACA events,
                and Day on the Hill is the one where your presence in Olympia
                does the most work. Anything open to you is listed below.
              </p>
            </EmptyState>
          )}
        </Section>

        <Section
          title="Open to you"
          description="Registration is invoiced, never charged to a card. You will receive an invoice by email and settle it offline."
          actions={<ActionLink href="/events">All events</ActionLink>}
        >
          {openForRegistration.length ? (
            <Rows>
              {openForRegistration.map((event) => (
                <Row key={event.id}>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                    <h3 className="text-[16px] font-medium text-zinc-900">
                      <Link href={`/events/${event.slug}`} className="portal-link">
                        {event.name}
                      </Link>
                    </h3>
                    <p className="tabular text-[14px] text-zinc-600">
                      {event.minPriceCents === null || event.minPriceCents === 0 ? (
                        "No charge"
                      ) : (
                        <>
                          from <Amount cents={event.minPriceCents} />
                        </>
                      )}
                    </p>
                  </div>
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-zinc-500">
                    <span>{EVENT_KIND_LABELS[event.kind]}</span>
                    <span>{formatDateRange(event.startsAt, event.endsAt)}</span>
                    <span>
                      {event.isVirtual
                        ? "Online"
                        : [event.venueName, event.city].filter(Boolean).join(", ") ||
                          "Venue to be confirmed"}
                    </span>
                    {event.visibility === "members-only" ? (
                      <Pill tone="quiet">Members only</Pill>
                    ) : null}
                  </p>
                  {event.summary ? (
                    <p className="portal-copy mt-2 text-[14px] text-zinc-600">
                      {event.summary}
                    </p>
                  ) : null}
                  <p className="mt-3">
                    <ActionLink href={`/events/${event.slug}`} variant="outline">
                      Register
                    </ActionLink>
                  </p>
                </Row>
              ))}
            </Rows>
          ) : (
            <EmptyState title="Nothing is open for registration right now.">
              <p>
                WACA publishes the conference and Day on the Hill dates well
                ahead. When registration opens it appears here, and the members
                rate is applied automatically to your organisation.
              </p>
            </EmptyState>
          )}
        </Section>

        <Section
          title="Your attendance"
          description={
            attendable
              ? `${attended} of ${attendable} past registrations checked in — ${percent(attended, attendable)}.`
              : undefined
          }
        >
          {past.length ? (
            <Rows>
              {past.map((registration) => (
                <Row key={registration.id}>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                    <p className="text-[15px] text-zinc-900">
                      <Link
                        href={`/events/${registration.eventSlug}`}
                        className="portal-link"
                      >
                        {registration.eventName}
                      </Link>
                    </p>
                    <p className="tabular text-[13px] text-zinc-500">
                      {formatDate(registration.eventStartsAt)}
                    </p>
                  </div>
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-zinc-500">
                    <span>{registration.ticketTypeName}</span>
                    {registration.checkedInAt ? (
                      <Pill tone="positive">Attended</Pill>
                    ) : registration.status === "cancelled" ? (
                      <Pill tone="quiet">Cancelled</Pill>
                    ) : (
                      <Pill tone="quiet">No check-in recorded</Pill>
                    )}
                  </p>
                </Row>
              ))}
            </Rows>
          ) : (
            <EmptyState title="No history yet.">
              <p>
                Once you have attended a WACA event, your check-ins appear here.
                It is also what staff look at when deciding which sessions to
                run again.
              </p>
            </EmptyState>
          )}
        </Section>
      </div>
    </>
  );
}
