/**
 * REGISTRATION FLOW TEST
 *
 * Run:  npm run test:events:registration
 *
 * Exercises the public registration path end to end against the real
 * database: registrations are created as `pending`, ONE invoice is raised
 * through the finance module (never by the events module itself), the
 * waitlist absorbs the overflow when a ticket type is full, and no card data
 * is involved anywhere — the invoice is settled offline.
 *
 * Everything it creates is deleted again in the finally block.
 */

import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { events, invoiceLines, invoices, registrations, ticketTypes } from "@/db/schema";
import { PUBLIC_VIEWER } from "@/db/queries";
import { RegistrationError, registerForEvent } from "@/lib/events/registration";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const stamp = Date.now();
  const [event] = await db
    .insert(events)
    .values({
      name: "TEST Registration Flow Conference",
      slug: `test-registration-flow-${stamp}`,
      kind: "conference",
      status: "published",
      visibility: "public",
      startsAt: new Date(Date.now() + 30 * 86_400_000),
      endsAt: new Date(Date.now() + 31 * 86_400_000),
      registrationOpensAt: new Date(Date.now() - 86_400_000),
      registrationClosesAt: new Date(Date.now() + 20 * 86_400_000),
      waitlistEnabled: true,
      venueName: "Test Hall",
      city: "Olympia",
    })
    .returning();

  const [openTicket, tinyTicket, closedTicket] = await db
    .insert(ticketTypes)
    .values([
      {
        eventId: event.id,
        name: "Full Event Registration with Wine",
        priceCents: 55000,
        sortOrder: 10,
      },
      { eventId: event.id, name: "Wine Tour Guest", priceCents: 12500, capacity: 1, sortOrder: 20 },
      {
        eventId: event.id,
        name: "Early Bird",
        priceCents: 30000,
        availableUntil: new Date(Date.now() - 86_400_000),
        sortOrder: 30,
      },
    ])
    .returning();

  const createdInvoiceIds: string[] = [];

  try {
    console.log("\nHappy path — two seats plus a guest");
    const outcome = await registerForEvent(
      {
        eventId: event.id,
        attendeeName: "Dana Ortiz",
        attendeeEmail: "dana.ortiz@example.org",
        attendeeTitle: "Compliance Lead",
        attendeeOrganizationName: "Cascade Test Co",
        dietaryNotes: "Gluten free",
        accessibilityNotes: null,
        lines: [{ ticketTypeId: openTicket.id, quantity: 2 }],
        guests: [{ name: "Sam Guest", email: "sam.guest@example.org", ticketTypeId: undefined, notes: null }],
      },
      PUBLIC_VIEWER,
    );
    if (outcome.invoice) createdInvoiceIds.push(outcome.invoice.id);

    check("two registrations were created", outcome.registrationIds.length === 2);
    check("nothing was waitlisted", outcome.waitlistedCount === 0);
    check("one invoice was raised", outcome.invoice !== null);
    check(
      "the invoice totals 2 x $550.00",
      outcome.invoice?.totalCents === 110000,
      String(outcome.invoice?.totalCents),
    );
    check(
      "the invoice number follows WACA-YYYY-NNNN",
      /^WACA-\d{4}-\d{4}$/.test(outcome.invoice?.number ?? ""),
      outcome.invoice?.number,
    );

    const rows = await db
      .select()
      .from(registrations)
      .where(eq(registrations.eventId, event.id));

    check("registrations start as pending, not confirmed", rows.every((r) => r.status === "pending"));
    check(
      "every registration points at the invoice",
      rows.every((r) => r.invoiceId === outcome.invoice?.id),
    );
    check(
      "the guest is recorded under their own name",
      rows.some((r) => r.attendeeName === "Sam Guest"),
    );
    check(
      "dietary needs are carried on the registration",
      rows.every((r) => r.guestFields.dietary_needs === "Gluten free"),
    );

    const lines = await db
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, outcome.invoice!.id));
    check("the invoice has one line for the ticket type", lines.length === 1);
    check("the line records quantity 2", lines[0]?.quantity === 2);
    check(
      "the line is linked back to the ticket type",
      lines[0]?.ticketTypeId === openTicket.id,
    );

    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, outcome.invoice!.id));
    check("the invoice source is event-registration", invoice.source === "event-registration");
    check("the invoice is issued, not draft", invoice.status === "sent");
    check("nothing has been paid yet", Number(invoice.amountPaidCents) === 0);
    check(
      "the invoice carries OFFLINE remittance terms",
      /cheque|ACH|bank transfer/i.test(invoice.paymentTerms ?? ""),
    );
    check(
      "the invoice mentions no card payment path",
      !/card|stripe|checkout/i.test(
        `${invoice.paymentTerms ?? ""} ${invoice.memo ?? ""}`.replace(
          /does not accept card payments/i,
          "",
        ),
      ),
    );

    const [counters] = await db
      .select({ registeredCount: events.registeredCount })
      .from(events)
      .where(eq(events.id, event.id));
    check("the event registered counter was refreshed", counters.registeredCount === 2);

    console.log("\nWaitlist — a capacity-1 ticket asked for twice");
    const waitlisted = await registerForEvent(
      {
        eventId: event.id,
        attendeeName: "Robin Vale",
        attendeeEmail: "robin.vale@example.org",
        attendeeTitle: null,
        attendeeOrganizationName: null,
        dietaryNotes: null,
        accessibilityNotes: null,
        lines: [{ ticketTypeId: tinyTicket.id, quantity: 2 }],
        guests: [],
      },
      PUBLIC_VIEWER,
    );
    if (waitlisted.invoice) createdInvoiceIds.push(waitlisted.invoice.id);

    check("one seat taken, one waitlisted", waitlisted.confirmedCount === 1 && waitlisted.waitlistedCount === 1);
    check(
      "only the seat that exists is invoiced",
      waitlisted.invoice?.totalCents === 12500,
      String(waitlisted.invoice?.totalCents),
    );

    const waitRows = await db
      .select()
      .from(registrations)
      .where(eq(registrations.ticketTypeId, tinyTicket.id));
    const waitRow = waitRows.find((r) => r.status === "waitlisted");
    check("the waitlisted row has a position", (waitRow?.waitlistPosition ?? 0) > 0);
    check("the waitlisted row is not invoiced", waitRow?.invoiceId === null);
    check("the waitlisted row is priced at zero", Number(waitRow?.pricePaidCents) === 0);

    console.log("\nRefusals");
    let code: string | null = null;
    try {
      await registerForEvent(
        {
          eventId: event.id,
          attendeeName: "Too Late",
          attendeeEmail: "too.late@example.org",
          attendeeTitle: null,
          attendeeOrganizationName: null,
          dietaryNotes: null,
          accessibilityNotes: null,
          lines: [{ ticketTypeId: closedTicket.id, quantity: 1 }],
          guests: [],
        },
        PUBLIC_VIEWER,
      );
    } catch (error) {
      code = error instanceof RegistrationError ? error.code : `other:${error}`;
    }
    check("a ticket past its on-sale window is refused", code === "closed", `got ${code}`);

    await db
      .update(events)
      .set({ registrationClosesAt: new Date(Date.now() - 3600_000) })
      .where(eq(events.id, event.id));

    code = null;
    try {
      await registerForEvent(
        {
          eventId: event.id,
          attendeeName: "After The Bell",
          attendeeEmail: "after.bell@example.org",
          attendeeTitle: null,
          attendeeOrganizationName: null,
          dietaryNotes: null,
          accessibilityNotes: null,
          lines: [{ ticketTypeId: openTicket.id, quantity: 1 }],
          guests: [],
        },
        PUBLIC_VIEWER,
      );
    } catch (error) {
      code = error instanceof RegistrationError ? error.code : `other:${error}`;
    }
    check("registration after the close date is refused", code === "closed", `got ${code}`);
  } finally {
    await db.delete(registrations).where(eq(registrations.eventId, event.id));
    if (createdInvoiceIds.length) {
      await db.delete(invoices).where(inArray(invoices.id, createdInvoiceIds));
    }
    await db.delete(ticketTypes).where(eq(ticketTypes.eventId, event.id));
    await db.delete(events).where(eq(events.id, event.id));
  }

  console.log(
    `\n${failures.length === 0 ? "PASS" : "FAIL"} — ${passed} checks passed, ${failures.length} failed.`,
  );
  if (failures.length) {
    for (const f of failures) console.error(`  · ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
