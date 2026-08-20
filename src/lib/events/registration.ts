import { and, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { events, registrations, ticketTypes } from "@/db/schema";
import { getEventDetail, isStaff, type Viewer } from "@/db/queries";
import { createEventRegistrationInvoice } from "@/lib/finance/event-invoices";
import { formatCents, formatDateRange } from "./format";
import { sendRegistrationConfirmation } from "./email";
import type { PublicRegistrationInput } from "./schemas";

/**
 * PUBLIC / MEMBER REGISTRATION FLOW.
 *
 * The event is fetched through getEventDetail(id, viewer) — the same
 * visibility gate the public list uses — so a guessed id for a legislator
 * fundraiser fails as a 404 here exactly as it does everywhere else.
 *
 * On submit: registrations are created as `pending` (or `waitlisted` when the
 * ticket type is full), then ONE invoice is raised for the order through the
 * finance module. There is NO card checkout: WACA invoices and settles
 * offline, and the "checkout" handoff is the remittance instructions on the
 * confirmation page and the emailed invoice.
 */

export class RegistrationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not-found"
      | "closed"
      | "member-only"
      | "duplicate"
      | "sold-out"
      | "invalid",
  ) {
    super(message);
    this.name = "RegistrationError";
  }
}

export interface RegistrationOutcome {
  eventSlug: string;
  registrationIds: string[];
  waitlistedCount: number;
  confirmedCount: number;
  invoice: { id: string; number: string; totalCents: number; dueOn: string } | null;
  emailDelivered: boolean;
}

/** Authoritative registration-window check. */
export function assertRegistrationOpen(event: {
  status: string;
  registrationOpensAt: Date | null;
  registrationClosesAt: Date | null;
  startsAt: Date;
}) {
  const now = Date.now();
  if (event.status !== "published") {
    throw new RegistrationError("Registration is not open for this event.", "closed");
  }
  if (event.registrationOpensAt && event.registrationOpensAt.getTime() > now) {
    throw new RegistrationError("Registration has not opened yet.", "closed");
  }
  const closesAt = event.registrationClosesAt ?? event.startsAt;
  if (closesAt && closesAt.getTime() < now) {
    throw new RegistrationError("Registration has closed for this event.", "closed");
  }
}

/** Seats still available on a ticket type; null when it is uncapped. */
export function seatsRemaining(
  ticket: { capacity: number | null },
  taken: number,
): number | null {
  if (ticket.capacity == null) return null;
  return Math.max(0, ticket.capacity - taken);
}

export async function registerForEvent(
  input: PublicRegistrationInput,
  viewer: Viewer,
  opts: { appUrl?: string } = {},
): Promise<RegistrationOutcome> {
  const detail = await getEventDetail(input.eventId, viewer);
  // null = does not exist OR this viewer may not see it. Both are a 404.
  if (!detail) {
    throw new RegistrationError("Event not found.", "not-found");
  }

  const { event } = detail;
  assertRegistrationOpen(event);

  const wanted = input.lines.filter((l) => l.quantity > 0);
  if (!wanted.length) {
    throw new RegistrationError("Choose at least one ticket.", "invalid");
  }

  // Only ticket types getEventDetail already deemed visible to this viewer.
  const ticketById = new Map(detail.ticketTypes.map((t) => [t.id, t]));
  const staff = isStaff(viewer);

  for (const line of wanted) {
    const ticket = ticketById.get(line.ticketTypeId);
    if (!ticket || !ticket.isActive || (ticket.isInternal && !staff)) {
      throw new RegistrationError("That ticket type is not available.", "invalid");
    }
    if (ticket.memberOnly && !viewer.contactId) {
      throw new RegistrationError(
        `"${ticket.name}" is open to WACA members only. Please sign in.`,
        "member-only",
      );
    }
    if (
      ticket.memberOnly &&
      ticket.levelRestrictions.length > 0 &&
      (!viewer.membershipLevelId ||
        !ticket.levelRestrictions.includes(viewer.membershipLevelId))
    ) {
      throw new RegistrationError(
        `"${ticket.name}" is restricted to certain membership levels.`,
        "member-only",
      );
    }
    const now = Date.now();
    if (ticket.availableFrom && ticket.availableFrom.getTime() > now) {
      throw new RegistrationError(`"${ticket.name}" is not on sale yet.`, "closed");
    }
    if (ticket.availableUntil && ticket.availableUntil.getTime() < now) {
      throw new RegistrationError(`"${ticket.name}" is no longer on sale.`, "closed");
    }
    if (line.quantity < ticket.minPerOrder) {
      throw new RegistrationError(
        `"${ticket.name}" has a minimum of ${ticket.minPerOrder} per order.`,
        "invalid",
      );
    }
    if (ticket.maxPerOrder != null && line.quantity > ticket.maxPerOrder) {
      throw new RegistrationError(
        `"${ticket.name}" is limited to ${ticket.maxPerOrder} per order.`,
        "invalid",
      );
    }
  }

  // A member already holding this ticket type would violate the
  // (event, contact, ticket) unique index — say so instead of 500ing.
  if (viewer.contactId) {
    const held = new Set(
      detail.myRegistrations
        .filter((r) => r.status !== "cancelled")
        .map((r) => r.ticketTypeId),
    );
    for (const line of wanted) {
      if (held.has(line.ticketTypeId)) {
        throw new RegistrationError(
          `You are already registered for "${ticketById.get(line.ticketTypeId)?.name}".`,
          "duplicate",
        );
      }
    }
  }

  const guests = [...input.guests];
  const notes: Record<string, unknown> = {};
  if (input.dietaryNotes) notes.dietary_needs = input.dietaryNotes;
  if (input.accessibilityNotes) notes.accessibility_needs = input.accessibilityNotes;

  const outcome = await defaultDb.transaction(async (tx) => {
    // Lock the seat counts for the ticket types in this order.
    const ticketIds = wanted.map((l) => l.ticketTypeId);
    const liveTickets = await tx
      .select()
      .from(ticketTypes)
      .where(inArray(ticketTypes.id, ticketIds))
      .for("update");

    const takenRows = await tx
      .select({
        ticketTypeId: registrations.ticketTypeId,
        taken: sql<number>`count(*) filter (where ${registrations.status} in ('pending','confirmed'))::int`,
        maxWaitlist: sql<number>`coalesce(max(${registrations.waitlistPosition}), 0)::int`,
      })
      .from(registrations)
      .where(
        and(
          eq(registrations.eventId, event.id),
          inArray(registrations.ticketTypeId, ticketIds),
        ),
      )
      .groupBy(registrations.ticketTypeId);

    const takenBy = new Map(
      takenRows.map((r) => [
        r.ticketTypeId,
        { taken: Number(r.taken), maxWaitlist: Number(r.maxWaitlist) },
      ]),
    );

    // Event-wide capacity, counted across every ticket type.
    let eventSeatsLeft: number | null = null;
    if (event.capacity != null) {
      const [row] = await tx
        .select({
          taken: sql<number>`count(*) filter (where ${registrations.status} in ('pending','confirmed'))::int`,
        })
        .from(registrations)
        .where(eq(registrations.eventId, event.id));
      eventSeatsLeft = Math.max(0, event.capacity - Number(row?.taken ?? 0));
    }

    const rows: (typeof registrations.$inferInsert)[] = [];
    const invoiceLines: {
      description: string;
      quantity: number;
      unitPriceCents: number;
      ticketTypeId: string;
    }[] = [];
    let waitlistedCount = 0;
    let confirmedCount = 0;
    let guestCursor = 0;
    let primaryUsed = false;

    for (const line of wanted) {
      const ticket =
        liveTickets.find((t) => t.id === line.ticketTypeId) ??
        ticketById.get(line.ticketTypeId)!;
      const counters = takenBy.get(line.ticketTypeId) ?? { taken: 0, maxWaitlist: 0 };
      let remaining = seatsRemaining(ticket, counters.taken);
      let waitlistCursor = counters.maxWaitlist;
      let billable = 0;

      for (let seat = 0; seat < line.quantity; seat++) {
        const capped =
          (remaining !== null && remaining <= 0) ||
          (eventSeatsLeft !== null && eventSeatsLeft <= 0);

        if (capped && !event.waitlistEnabled) {
          throw new RegistrationError(
            `"${ticket.name}" is sold out.`,
            "sold-out",
          );
        }

        const isPrimary = !primaryUsed;
        const guest = isPrimary ? null : (guests[guestCursor++] ?? null);
        primaryUsed = true;

        const attendeeName = isPrimary
          ? input.attendeeName
          : (guest?.name ?? `Guest of ${input.attendeeName}`);
        const attendeeEmail = isPrimary
          ? input.attendeeEmail
          : (guest?.email ?? input.attendeeEmail);

        rows.push({
          eventId: event.id,
          ticketTypeId: ticket.id,
          // Only the primary seat is tied to the member's contact record:
          // guests are separate people, and the (event, contact, ticket)
          // unique index would reject a second row for the same contact.
          contactId: isPrimary ? viewer.contactId : null,
          organizationId: viewer.organizationId,
          status: capped ? "waitlisted" : "pending",
          attendeeName,
          attendeeEmail,
          attendeeTitle: isPrimary ? (input.attendeeTitle ?? null) : null,
          attendeeOrganizationName: input.attendeeOrganizationName ?? null,
          guestFields: {
            ...notes,
            ...(isPrimary ? {} : { is_guest: true }),
            ...(guest?.notes ? { guest_notes: guest.notes } : {}),
          },
          pricePaidCents: capped ? 0 : ticket.priceCents,
          waitlistPosition: capped ? ++waitlistCursor : null,
        });

        if (capped) {
          waitlistedCount++;
        } else {
          confirmedCount++;
          billable++;
          if (remaining !== null) remaining--;
          if (eventSeatsLeft !== null) eventSeatsLeft--;
        }
      }

      if (billable > 0 && ticket.priceCents > 0) {
        invoiceLines.push({
          description: `${event.name} — ${ticket.name}`,
          quantity: billable,
          unitPriceCents: ticket.priceCents,
          ticketTypeId: ticket.id,
        });
      }
    }

    const inserted = await tx
      .insert(registrations)
      .values(rows)
      .returning({ id: registrations.id, status: registrations.status });

    // ONE invoice for the order, raised by the finance module. Free and
    // fully-waitlisted orders raise nothing.
    let invoice: RegistrationOutcome["invoice"] = null;
    if (invoiceLines.length) {
      const created = await createEventRegistrationInvoice({
        db: tx,
        organizationId: viewer.organizationId,
        contactId: viewer.contactId,
        eventId: event.id,
        registrationId: inserted.length === 1 ? inserted[0].id : null,
        lines: invoiceLines,
        billTo: {
          name: input.attendeeName,
          email: input.attendeeEmail,
          organization: input.attendeeOrganizationName ?? null,
        },
        memo: `Event registration — ${event.name}`,
        status: "sent",
      });
      invoice = {
        id: created.id,
        number: created.number,
        totalCents: created.totalCents,
        dueOn: created.dueOn,
      };

      await tx
        .update(registrations)
        .set({ invoiceId: created.id })
        .where(
          inArray(
            registrations.id,
            inserted.filter((r) => r.status !== "waitlisted").map((r) => r.id),
          ),
        );
    }

    // Counter maintenance: ticket_types.sold_count and events.registered_count.
    for (const line of wanted) {
      const sold = rows.filter(
        (r) => r.ticketTypeId === line.ticketTypeId && r.status === "pending",
      ).length;
      if (sold > 0) {
        await tx
          .update(ticketTypes)
          .set({ soldCount: sql`${ticketTypes.soldCount} + ${sold}` })
          .where(eq(ticketTypes.id, line.ticketTypeId));
      }
    }
    await tx
      .update(events)
      .set({
        registeredCount: sql`(
          select count(*)::int from ${registrations} r
           where r.event_id = ${event.id} and r.status <> 'cancelled'
        )`,
      })
      .where(eq(events.id, event.id));

    return {
      registrationIds: inserted.map((r) => r.id),
      waitlistedCount,
      confirmedCount,
      invoice,
      breakdown: wanted.map((line) => ({
        ticketTypeId: line.ticketTypeId,
        confirmed: rows.filter(
          (r) => r.ticketTypeId === line.ticketTypeId && r.status === "pending",
        ).length,
        waitlisted: rows.filter(
          (r) => r.ticketTypeId === line.ticketTypeId && r.status === "waitlisted",
        ).length,
      })),
    };
  });

  const appUrl =
    opts.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  const mail = await sendRegistrationConfirmation({
    to: input.attendeeEmail,
    attendeeName: input.attendeeName,
    eventName: event.name,
    eventWhen: formatDateRange(event.startsAt, event.endsAt),
    eventWhere: event.isVirtual
      ? "Online"
      : [event.venueName, event.city, event.state].filter(Boolean).join(", ") ||
        "To be confirmed",
    eventUrl: `${appUrl}/events/${event.slug}`,
    // The email reports what was actually taken, not what was asked for:
    // an overflow seat is listed under "waitlisted", never under "registered".
    items: outcome.breakdown
      .filter((b) => b.confirmed > 0)
      .map((b) => {
        const t = ticketById.get(b.ticketTypeId)!;
        return {
          label: t.name,
          quantity: b.confirmed,
          amount: formatCents(t.priceCents * b.confirmed),
        };
      }),
    waitlisted: outcome.breakdown
      .filter((b) => b.waitlisted > 0)
      .map((b) => ({
        label: ticketById.get(b.ticketTypeId)!.name,
        quantity: b.waitlisted,
      })),
    invoice: outcome.invoice
      ? {
          number: outcome.invoice.number,
          total: formatCents(outcome.invoice.totalCents),
          dueOn: outcome.invoice.dueOn,
        }
      : null,
  });

  const { breakdown: _breakdown, ...rest } = outcome;

  return {
    eventSlug: event.slug,
    ...rest,
    emailDelivered: mail.delivered,
  };
}
