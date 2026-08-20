import { and, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb, type DbExecutor } from "@/db";
import {
  eventSponsorships,
  events,
  invoices,
  membershipLevels,
  memberships,
  registrations,
  sponsorTiers,
  ticketTypes,
} from "@/db/schema";
import { recordFinanceAudit, SYSTEM_ACTOR, type FinanceActor } from "./actor";
import { FinanceError } from "./errors";
import {
  addDays,
  createInvoice,
  DEFAULT_NET_DAYS,
  isoDate,
  toSummary,
  type InvoiceSummary,
} from "./invoices";

/**
 * ===========================================================================
 *  THE FOUR THINGS THAT RAISE AN INVOICE AT WACA
 *
 *    a new membership application   invoiceForMembership(id, 'new')
 *    an annual renewal              invoiceForMembership(id, 'renewal')
 *    a level change                 invoiceForMembership(id, 'level-change')
 *    an event registration          invoiceForRegistration(id)
 *    a conference sponsorship       invoiceForSponsorship(id)
 *
 *  Each is a thin, opinionated wrapper over createInvoice(): it resolves the
 *  price from the source record, writes a line description a member will
 *  recognise on a statement, and links the invoice back so the source row can
 *  find it again. Callers do not build lines by hand — that is how two
 *  modules end up describing the same $6,300 differently.
 *
 *  Each is IDEMPOTENT: if the source already has an open (non-void) invoice,
 *  the existing one is returned rather than a duplicate raised. A retried
 *  form submit must not bill a member twice.
 *
 *  NO CARD PROCESSING. Each of these raises a document; none of them takes
 *  money. Settlement is offline and recorded by hand.
 * ===========================================================================
 */

export type MembershipInvoiceKind = "new" | "renewal" | "level-change";

const MEMBERSHIP_SOURCE = {
  new: "membership-new",
  renewal: "membership-renewal",
  "level-change": "membership-level-change",
} as const;

const MEMBERSHIP_LABEL: Record<MembershipInvoiceKind, string> = {
  new: "new membership",
  renewal: "annual membership renewal",
  "level-change": "membership level change",
};

/** Statuses that mean "this invoice still counts", for the dedupe check. */
const LIVE_STATUSES = [
  "draft",
  "sent",
  "partially-paid",
  "overdue",
  "paid",
] as const;

export interface SourceInvoiceOpts {
  /** Override the resolved fee, in cents. For a pro-rated level change. */
  feeCentsOverride?: number;
  /** ISO yyyy-mm-dd. Defaults to issue + 30 days, or the expiry if sooner. */
  dueOn?: string | null;
  /** 'draft' (default) leaves it for staff to send. */
  status?: "draft" | "sent";
  reference?: string | null;
  memo?: string | null;
  /** Return the existing live invoice instead of raising a second one. */
  reuseExisting?: boolean;
  /** Links the invoice back to the application that produced it. */
  membershipApplicationId?: string | null;
  /** Overrides the term used in the line description (approval sets a term). */
  termStartsOn?: string | null;
  termEndsOn?: string | null;
  actor?: FinanceActor;
  db?: DbExecutor;
}

/* ===================================================================== */
/*  invoiceForMembership                                                 */
/* ===================================================================== */

/**
 * Raises the dues invoice for a membership term.
 *
 * The fee is the one snapshotted on the membership (`fee_charged_cents`) if
 * there is one, and the level's list price otherwise — a member on a
 * negotiated rate must not silently be re-priced at renewal.
 *
 * The due date defaults to the EARLIER of net-30 and the expiry date: asking
 * a member to pay 30 days after their cover has already lapsed is how a
 * renewal-overdue pile builds up.
 */
export async function invoiceForMembership(
  membershipId: string,
  kind: MembershipInvoiceKind,
  opts: SourceInvoiceOpts = {},
): Promise<InvoiceSummary> {
  const actor = opts.actor ?? SYSTEM_ACTOR;

  const run = async (tx: DbExecutor): Promise<InvoiceSummary> => {
    const [row] = await tx
      .select({
        membershipId: memberships.id,
        organizationId: memberships.organizationId,
        levelId: membershipLevels.id,
        levelName: membershipLevels.name,
        billingPeriod: membershipLevels.billingPeriod,
        listFeeCents: membershipLevels.feeCents,
        chargedFeeCents: memberships.feeChargedCents,
        termStartsOn: memberships.termStartsOn,
        expiresOn: memberships.expiresOn,
      })
      .from(memberships)
      .innerJoin(membershipLevels, eq(membershipLevels.id, memberships.levelId))
      .where(eq(memberships.id, membershipId))
      .limit(1);

    if (!row) {
      throw new FinanceError("not-found", "That membership no longer exists.");
    }

    const source = MEMBERSHIP_SOURCE[kind];

    if (opts.reuseExisting !== false) {
      const existing = await findLiveInvoice(tx, [
        eq(invoices.membershipId, membershipId),
        eq(invoices.source, source),
      ]);
      if (existing) return existing;
    }

    const feeCents = Math.round(
      opts.feeCentsOverride ??
        Number(row.chargedFeeCents ?? row.listFeeCents ?? 0),
    );
    if (feeCents <= 0 && opts.feeCentsOverride === undefined) {
      throw new FinanceError(
        "invalid-amount",
        `${row.levelName} has no fee, so there is nothing to invoice. ` +
          "Lifetime and complimentary levels are not billed.",
      );
    }

    const issuedOn = isoDate(new Date());
    const netDue = addDays(issuedOn, DEFAULT_NET_DAYS);
    const dueOn =
      opts.dueOn ??
      // Renewal: due by the day cover lapses, or net-30, whichever is sooner.
      (kind === "renewal" && row.expiresOn && row.expiresOn > issuedOn
        ? row.expiresOn < netDue
          ? row.expiresOn
          : netDue
        : netDue);

    const period =
      row.billingPeriod === "monthly"
        ? "monthly dues"
        : row.billingPeriod === "lifetime"
          ? "lifetime membership"
          : "annual dues";

    // An approval hands us the term it just wrote; fall back to the row.
    const termFrom = opts.termStartsOn ?? row.termStartsOn;
    const termTo = opts.termEndsOn ?? row.expiresOn;
    const term =
      termFrom && termTo
        ? ` — ${termFrom} to ${termTo}`
        : termTo
          ? ` — term ending ${termTo}`
          : "";

    const invoice = await createInvoice({
      db: tx,
      actor,
      organizationId: row.organizationId,
      source,
      status: opts.status ?? "draft",
      membershipId,
      membershipApplicationId: opts.membershipApplicationId ?? null,
      issuedOn,
      dueOn,
      reference: opts.reference ?? null,
      memo: opts.memo ?? `${row.levelName} — ${MEMBERSHIP_LABEL[kind]}`,
      lines: [
        {
          description: `${row.levelName} — ${period}${term}`,
          quantity: 1,
          unitPriceCents: feeCents,
          membershipLevelId: row.levelId,
          glCode: "4000-dues",
        },
      ],
    });

    await recordFinanceAudit({
      db: tx,
      actor,
      action: "create",
      entity: "memberships",
      entityId: membershipId,
      after: {
        invoiceNumber: invoice.number,
        invoiceId: invoice.id,
        kind,
        totalCents: Number(invoice.totalCents),
      },
      metadata: { reason: "dues-invoice-raised" },
    });

    return invoice;
  };

  return opts.db ? run(opts.db) : defaultDb.transaction(run);
}

/* ===================================================================== */
/*  invoiceForRegistration                                               */
/* ===================================================================== */

/**
 * Raises the invoice for one event registration.
 *
 * Prices from the registration's own `price_paid_cents` — the ticket price
 * frozen at the moment of registration — so a later price change on the
 * ticket type does not rewrite history. Falls back to the ticket type's
 * current price only if the registration never captured one.
 *
 * Zero-priced registrations (Speaker, Staff, comped Attendee) raise NOTHING.
 * A $0 invoice is noise in the receivables list and an insult in the post.
 */
export async function invoiceForRegistration(
  registrationId: string,
  opts: SourceInvoiceOpts = {},
): Promise<InvoiceSummary | null> {
  const actor = opts.actor ?? SYSTEM_ACTOR;

  const run = async (tx: DbExecutor): Promise<InvoiceSummary | null> => {
    const [row] = await tx
      .select({
        registrationId: registrations.id,
        eventId: registrations.eventId,
        eventName: events.name,
        eventStartsAt: events.startsAt,
        ticketTypeId: registrations.ticketTypeId,
        ticketName: ticketTypes.name,
        ticketPriceCents: ticketTypes.priceCents,
        pricePaidCents: registrations.pricePaidCents,
        status: registrations.status,
        organizationId: registrations.organizationId,
        contactId: registrations.contactId,
        attendeeName: registrations.attendeeName,
        attendeeEmail: registrations.attendeeEmail,
        existingInvoiceId: registrations.invoiceId,
      })
      .from(registrations)
      .innerJoin(events, eq(events.id, registrations.eventId))
      .innerJoin(ticketTypes, eq(ticketTypes.id, registrations.ticketTypeId))
      .where(eq(registrations.id, registrationId))
      .limit(1);

    if (!row) {
      throw new FinanceError("not-found", "That registration no longer exists.");
    }
    if (row.status === "cancelled") {
      throw new FinanceError(
        "invalid-amount",
        "That registration is cancelled — do not invoice it.",
      );
    }

    if (opts.reuseExisting !== false) {
      const existing = await findLiveInvoice(tx, [
        eq(invoices.registrationId, registrationId),
      ]);
      if (existing) {
        // Backfill the back-reference. The invoice knows about the
        // registration but a row imported (or seeded) the other way round may
        // not know about its invoice, and leaving it null means the next call
        // looks like a fresh one.
        if (row.existingInvoiceId !== existing.id) {
          await tx
            .update(registrations)
            .set({ invoiceId: existing.id })
            .where(eq(registrations.id, registrationId));
        }
        return existing;
      }
    }

    // The price frozen on the registration wins; the ticket type's current
    // list price is only a fallback for a row that never captured one.
    const captured = Number(row.pricePaidCents ?? 0);
    const unitPriceCents = Math.round(
      opts.feeCentsOverride ??
        (captured > 0 ? captured : Number(row.ticketPriceCents ?? 0)),
    );

    if (unitPriceCents <= 0) return null; // comped — nothing to bill

    const issuedOn = isoDate(new Date());
    const netDue = addDays(issuedOn, DEFAULT_NET_DAYS);
    // Conferences want the money before the doors open.
    const eventDay = row.eventStartsAt
      ? isoDate(new Date(row.eventStartsAt))
      : null;
    const dueOn =
      opts.dueOn ??
      (eventDay && eventDay > issuedOn && eventDay < netDue ? eventDay : netDue);

    const invoice = await createInvoice({
      db: tx,
      actor,
      organizationId: row.organizationId,
      contactId: row.contactId,
      source: "event-registration",
      status: opts.status ?? "sent",
      eventId: row.eventId,
      registrationId,
      issuedOn,
      dueOn,
      reference: opts.reference ?? null,
      memo: opts.memo ?? `${row.eventName} — ${row.attendeeName}`,
      billTo: { attendeeName: row.attendeeName, attendeeEmail: row.attendeeEmail },
      lines: [
        {
          description: `${row.eventName} — ${row.ticketName} (${row.attendeeName})`,
          quantity: 1,
          unitPriceCents,
          ticketTypeId: row.ticketTypeId,
          glCode: "4200-events",
        },
      ],
    });

    await tx
      .update(registrations)
      .set({ invoiceId: invoice.id })
      .where(eq(registrations.id, registrationId));

    return invoice;
  };

  return opts.db ? run(opts.db) : defaultDb.transaction(run);
}

/* ===================================================================== */
/*  invoiceForSponsorship                                                */
/* ===================================================================== */

/**
 * Raises the invoice for a conference sponsorship.
 *
 * Every WACA conference is an event PLUS a paired sponsorship event, and the
 * sponsorship is where the real money is — Diamond and Platinum are five
 * figures. Prices from the sponsorship's agreed `amount_cents` (which may be
 * a negotiated figure) and falls back to the tier's list price.
 *
 * Moves the sponsorship to 'invoiced' so the sponsor pipeline stays honest.
 */
export async function invoiceForSponsorship(
  sponsorshipId: string,
  opts: SourceInvoiceOpts = {},
): Promise<InvoiceSummary> {
  const actor = opts.actor ?? SYSTEM_ACTOR;

  const run = async (tx: DbExecutor): Promise<InvoiceSummary> => {
    const [row] = await tx
      .select({
        sponsorshipId: eventSponsorships.id,
        eventId: eventSponsorships.eventId,
        eventName: events.name,
        eventStartsAt: events.startsAt,
        tierId: sponsorTiers.id,
        tierName: sponsorTiers.name,
        tierPriceCents: sponsorTiers.priceCents,
        agreedCents: eventSponsorships.amountCents,
        status: eventSponsorships.status,
        organizationId: eventSponsorships.organizationId,
        contactId: eventSponsorships.contactId,
        sponsorName: eventSponsorships.sponsorName,
      })
      .from(eventSponsorships)
      .innerJoin(events, eq(events.id, eventSponsorships.eventId))
      .innerJoin(
        sponsorTiers,
        eq(sponsorTiers.id, eventSponsorships.sponsorTierId),
      )
      .where(eq(eventSponsorships.id, sponsorshipId))
      .limit(1);

    if (!row) {
      throw new FinanceError("not-found", "That sponsorship no longer exists.");
    }
    if (row.status === "cancelled") {
      throw new FinanceError(
        "invalid-amount",
        "That sponsorship is cancelled — do not invoice it.",
      );
    }

    if (opts.reuseExisting !== false) {
      const existing = await findLiveInvoice(tx, [
        eq(invoices.eventSponsorshipId, sponsorshipId),
      ]);
      if (existing) {
        // Same backfill as invoiceForRegistration — keep the sponsorship
        // pointing at the invoice it already has.
        await tx
          .update(eventSponsorships)
          .set({ invoiceId: existing.id })
          .where(eq(eventSponsorships.id, sponsorshipId));
        return existing;
      }
    }

    const unitPriceCents = Math.round(
      opts.feeCentsOverride ??
        (Number(row.agreedCents) > 0
          ? Number(row.agreedCents)
          : Number(row.tierPriceCents ?? 0)),
    );
    if (unitPriceCents <= 0) {
      throw new FinanceError(
        "invalid-amount",
        `${row.tierName} for ${row.eventName} has no agreed amount. Set one before invoicing.`,
      );
    }

    const issuedOn = isoDate(new Date());
    const netDue = addDays(issuedOn, DEFAULT_NET_DAYS);
    const eventDay = row.eventStartsAt
      ? isoDate(new Date(row.eventStartsAt))
      : null;
    const dueOn =
      opts.dueOn ??
      (eventDay && eventDay > issuedOn && eventDay < netDue ? eventDay : netDue);

    const invoice = await createInvoice({
      db: tx,
      actor,
      organizationId: row.organizationId,
      contactId: row.contactId,
      source: "sponsorship",
      status: opts.status ?? "draft",
      eventId: row.eventId,
      eventSponsorshipId: sponsorshipId,
      issuedOn,
      dueOn,
      reference: opts.reference ?? null,
      memo: opts.memo ?? `${row.eventName} — ${row.tierName} sponsorship`,
      billTo: { sponsorName: row.sponsorName },
      lines: [
        {
          description: `${row.eventName} — ${row.tierName} sponsorship (${row.sponsorName})`,
          quantity: 1,
          unitPriceCents,
          sponsorTierId: row.tierId,
          glCode: "4300-sponsorship",
        },
      ],
    });

    await tx
      .update(eventSponsorships)
      .set({
        invoiceId: invoice.id,
        status: row.status === "paid" ? "paid" : "invoiced",
        updatedAt: new Date(),
      })
      .where(eq(eventSponsorships.id, sponsorshipId));

    await recordFinanceAudit({
      db: tx,
      actor,
      action: "status-change",
      entity: "event_sponsorships",
      entityId: sponsorshipId,
      before: { status: row.status },
      after: { status: "invoiced", invoiceNumber: invoice.number },
    });

    return invoice;
  };

  return opts.db ? run(opts.db) : defaultDb.transaction(run);
}

/* ===================================================================== */

/** The dedupe check every wrapper above shares. */
async function findLiveInvoice(
  tx: DbExecutor,
  conditions: ReturnType<typeof eq>[],
): Promise<InvoiceSummary | null> {
  const [existing] = await tx
    .select()
    .from(invoices)
    .where(and(...conditions, inArray(invoices.status, [...LIVE_STATUSES])))
    .orderBy(sql`${invoices.createdAt} desc`)
    .limit(1);

  if (!existing) return null;
  return toSummary(existing);
}
