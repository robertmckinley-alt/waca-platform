"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import {
  eventSessions,
  events,
  registrations,
  sponsorTiers,
  ticketTypes,
} from "@/db/schema";
import type { DbExecutor } from "@/db";
import {
  fail,
  formToObject,
  invalid,
  ok,
  type ActionState,
} from "@/lib/action-state";
import { requireStaff } from "@/lib/admin-auth";
import { diffFields, hasChanges, recordAudit } from "@/lib/audit";
import {
  cloneEventSchema,
  eventInputSchema,
  eventSessionSchema,
  slugify,
  sponsorTierSchema,
  ticketTypeSchema,
} from "./schemas";
import { SPONSOR_TIER_PRESETS, TICKET_TYPE_PRESETS } from "./presets";
import { sendWaitlistPromotion } from "./email";

/**
 * ADMIN SERVER ACTIONS for the events module.
 *
 * Every one of these calls requireStaff() first: a server action is a public
 * POST endpoint, so the middleware gate on /admin/* is not enough on its own.
 * Every mutation writes an audit row.
 */

/**
 * True when `error` is a Postgres unique-violation on `constraint`.
 *
 * Drizzle wraps the driver error, so the constraint name is only reachable
 * through the `cause` chain — String(error) does NOT contain it, and matching
 * on the message silently misses, turning a friendly "that name is taken"
 * into a 500.
 */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const candidate = current as {
      code?: string;
      constraint_name?: string;
      cause?: unknown;
    };
    if (candidate.code === "23505" && candidate.constraint_name === constraint) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

/** Slug that is unique across events, suffixing -2, -3 … when taken. */
async function uniqueSlug(
  executor: DbExecutor,
  desired: string,
  ignoreId?: string,
): Promise<string> {
  const base = slugify(desired) || "event";
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const [clash] = await executor
      .select({ id: events.id })
      .from(events)
      .where(eq(events.slug, candidate))
      .limit(1);
    if (!clash || clash.id === ignoreId) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/* ==================================================================== */
/*  Event create / update                                               */
/* ==================================================================== */

export async function createEventAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const parsed = eventInputSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;

  const eventId = await db.transaction(async (tx) => {
    const slug = await uniqueSlug(tx, input.slug ?? input.name);
    const visibility =
      input.memberOnly && input.visibility === "public"
        ? "members-only"
        : input.visibility;

    const [created] = await tx
      .insert(events)
      .values({
        name: input.name,
        slug,
        kind: input.kind as typeof events.$inferInsert.kind,
        status: input.status,
        visibility: visibility as typeof events.$inferInsert.visibility,
        summary: input.summary,
        description: input.description,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        timezone: input.timezone,
        venueName: input.venueName,
        venueAddress: input.venueAddress,
        city: input.city,
        state: input.state ?? "WA",
        isVirtual: input.isVirtual,
        virtualUrl: input.virtualUrl,
        capacity: input.capacity,
        registrationOpensAt: input.registrationOpensAt,
        registrationClosesAt: input.registrationClosesAt,
        waitlistEnabled: input.waitlistEnabled,
        councilId: input.councilId,
        contactEmail: input.contactEmail,
      })
      .returning({ id: events.id });

    // Every conference is an event PLUS a paired sponsorship event.
    if (input.createPairedSponsorship) {
      const sponsorshipSlug = await uniqueSlug(tx, `${slug}-sponsorship`);
      const [sponsorship] = await tx
        .insert(events)
        .values({
          name: `${input.name} — Sponsorship`,
          slug: sponsorshipSlug,
          kind: "sponsorship",
          status: input.status,
          visibility: visibility as typeof events.$inferInsert.visibility,
          summary: `Sponsorship opportunities for ${input.name}.`,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          timezone: input.timezone,
          venueName: input.venueName,
          city: input.city,
          state: input.state ?? "WA",
          pairedSponsorshipEventId: null,
        })
        .returning({ id: events.id });

      await tx
        .update(events)
        .set({ pairedSponsorshipEventId: sponsorship.id })
        .where(eq(events.id, created.id));

      await recordAudit({
        db: tx,
        actor,
        action: "create",
        entity: "events",
        entityId: sponsorship.id,
        after: { name: `${input.name} — Sponsorship`, kind: "sponsorship" },
        metadata: { pairedWith: created.id },
      });
    }

    await recordAudit({
      db: tx,
      actor,
      action: "create",
      entity: "events",
      entityId: created.id,
      after: { name: input.name, slug, kind: input.kind, visibility },
    });

    return created.id;
  });

  revalidatePath("/admin/events");
  revalidatePath("/events");
  redirect(`/admin/events/${eventId}`);
}

export async function updateEventAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const id = String(formData.get("id") ?? "");
  if (!z.uuid().safeParse(id).success) {
    return fail("Unknown event.");
  }
  const parsed = eventInputSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;

  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(events).where(eq(events.id, id)).limit(1);
    if (!before) throw new Error("Event not found.");

    const slug =
      input.slug && input.slug !== before.slug
        ? await uniqueSlug(tx, input.slug, id)
        : before.slug;

    const after = {
      name: input.name,
      slug,
      kind: input.kind as typeof events.$inferInsert.kind,
      status: input.status,
      visibility: input.visibility as typeof events.$inferInsert.visibility,
      summary: input.summary,
      description: input.description,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      timezone: input.timezone,
      venueName: input.venueName,
      venueAddress: input.venueAddress,
      city: input.city,
      state: input.state ?? "WA",
      isVirtual: input.isVirtual,
      virtualUrl: input.virtualUrl,
      capacity: input.capacity,
      registrationOpensAt: input.registrationOpensAt,
      registrationClosesAt: input.registrationClosesAt,
      waitlistEnabled: input.waitlistEnabled,
      councilId: input.councilId,
      contactEmail: input.contactEmail,
      updatedAt: new Date(),
    };

    await tx.update(events).set(after).where(eq(events.id, id));

    const diff = diffFields(before as unknown as Record<string, unknown>, after);
    if (hasChanges(diff)) {
      await recordAudit({
        db: tx,
        actor,
        action: "update",
        entity: "events",
        entityId: id,
        before: diff.before,
        after: diff.after,
      });
    }
  });

  revalidatePath(`/admin/events/${id}`);
  revalidatePath("/admin/events");
  revalidatePath("/events");
  return ok("Event saved.");
}

export async function setEventStatusAction(formData: FormData): Promise<void> {
  const actor = await requireStaff();
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  const allowed = ["draft", "published", "cancelled", "completed"] as const;
  if (!z.uuid().safeParse(id).success) return;
  if (!(allowed as readonly string[]).includes(status)) return;

  await db
    .update(events)
    .set({ status: status as (typeof allowed)[number], updatedAt: new Date() })
    .where(eq(events.id, id));
  await recordAudit({
    actor,
    action: "status-change",
    entity: "events",
    entityId: id,
    after: { status },
  });
  revalidatePath(`/admin/events/${id}`);
  revalidatePath("/admin/events");
  revalidatePath("/events");
}

/* ==================================================================== */
/*  Ticket types                                                        */
/* ==================================================================== */

export async function saveTicketTypeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const eventId = String(formData.get("eventId") ?? "");
  if (!z.uuid().safeParse(eventId).success) {
    return fail("Unknown event.");
  }
  const parsed = ticketTypeSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;

  const values = {
    eventId,
    name: input.name,
    description: input.description,
    priceCents: input.priceCents,
    capacity: input.capacity,
    availableFrom: input.availableFrom,
    availableUntil: input.availableUntil,
    memberOnly: input.memberOnly,
    isInternal: input.isInternal,
    isActive: input.isActive,
    minPerOrder: input.minPerOrder,
    maxPerOrder: input.maxPerOrder,
    sortOrder: input.sortOrder,
  };

  try {
    if (input.id) {
      await db
        .update(ticketTypes)
        .set({ ...values, updatedAt: new Date() })
        .where(and(eq(ticketTypes.id, input.id), eq(ticketTypes.eventId, eventId)));
      await recordAudit({
        actor,
        action: "update",
        entity: "ticket_types",
        entityId: input.id,
        after: values,
      });
    } else {
      const [created] = await db
        .insert(ticketTypes)
        .values(values)
        .returning({ id: ticketTypes.id });
      await recordAudit({
        actor,
        action: "create",
        entity: "ticket_types",
        entityId: created.id,
        after: values,
      });
    }
  } catch (error) {
    if (isUniqueViolation(error, "ticket_types_event_name_uq")) {
      return {
        status: "error",
        message: `This event already has a ticket type called "${input.name}".`,
        fieldErrors: { name: ["Already used on this event"] },
      };
    }
    throw error;
  }

  revalidatePath(`/admin/events/${eventId}/tickets`);
  revalidatePath(`/admin/events/${eventId}`);
  return ok("Ticket type saved.");
}

export async function deleteTicketTypeAction(formData: FormData): Promise<void> {
  const actor = await requireStaff();
  const eventId = String(formData.get("eventId") ?? "");
  const id = String(formData.get("id") ?? "");
  if (!z.uuid().safeParse(id).success) return;

  const [used] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(registrations)
    .where(eq(registrations.ticketTypeId, id));

  if (Number(used?.n ?? 0) > 0) {
    // Registrations reference it (ON DELETE RESTRICT) — retire it instead.
    await db
      .update(ticketTypes)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(ticketTypes.id, id));
    await recordAudit({
      actor,
      action: "archive",
      entity: "ticket_types",
      entityId: id,
      metadata: { reason: "has registrations", registrations: Number(used?.n) },
    });
  } else {
    await db.delete(ticketTypes).where(eq(ticketTypes.id, id));
    await recordAudit({ actor, action: "delete", entity: "ticket_types", entityId: id });
  }

  revalidatePath(`/admin/events/${eventId}/tickets`);
}

/** One-click: add the real WACA ticket vocabulary, skipping ones present. */
export async function applyTicketPresetsAction(formData: FormData): Promise<void> {
  const actor = await requireStaff();
  const eventId = String(formData.get("eventId") ?? "");
  if (!z.uuid().safeParse(eventId).success) return;
  const names = formData.getAll("preset").map(String);
  const chosen = TICKET_TYPE_PRESETS.filter((p) => names.includes(p.name));
  if (!chosen.length) return;

  const existing = await db
    .select({ name: ticketTypes.name })
    .from(ticketTypes)
    .where(eq(ticketTypes.eventId, eventId));
  const have = new Set(existing.map((e) => e.name));
  const toInsert = chosen.filter((p) => !have.has(p.name));
  if (!toInsert.length) return;

  await db.insert(ticketTypes).values(
    toInsert.map((p) => ({
      eventId,
      name: p.name,
      description: p.description ?? null,
      priceCents: p.priceCents,
      memberOnly: p.memberOnly,
      isInternal: p.isInternal,
      sortOrder: p.sortOrder,
    })),
  );
  await recordAudit({
    actor,
    action: "create",
    entity: "ticket_types",
    entityId: eventId,
    after: { presets: toInsert.map((p) => p.name) },
    metadata: { via: "preset" },
  });

  revalidatePath(`/admin/events/${eventId}/tickets`);
}

/* ==================================================================== */
/*  Sponsor tiers                                                       */
/* ==================================================================== */

export async function saveSponsorTierAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const eventId = String(formData.get("eventId") ?? "");
  if (!z.uuid().safeParse(eventId).success) {
    return fail("Unknown event.");
  }
  const parsed = sponsorTierSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;

  const values = {
    eventId,
    name: input.name,
    priceCents: input.priceCents,
    inventory: input.inventory,
    includedTickets: input.includedTickets,
    benefits: input.benefits,
    isActive: input.isActive,
    sortOrder: input.sortOrder,
  };

  try {
    if (input.id) {
      await db
        .update(sponsorTiers)
        .set({ ...values, updatedAt: new Date() })
        .where(and(eq(sponsorTiers.id, input.id), eq(sponsorTiers.eventId, eventId)));
      await recordAudit({
        actor,
        action: "update",
        entity: "sponsor_tiers",
        entityId: input.id,
        after: values,
      });
    } else {
      const [created] = await db
        .insert(sponsorTiers)
        .values(values)
        .returning({ id: sponsorTiers.id });
      await recordAudit({
        actor,
        action: "create",
        entity: "sponsor_tiers",
        entityId: created.id,
        after: values,
      });
    }
  } catch (error) {
    if (isUniqueViolation(error, "sponsor_tiers_event_name_uq")) {
      return {
        status: "error",
        message: `This event already has a "${input.name}" tier.`,
        fieldErrors: { name: ["Already used on this event"] },
      };
    }
    throw error;
  }

  revalidatePath(`/admin/events/${eventId}/sponsors`);
  return ok("Sponsor tier saved.");
}

export async function deleteSponsorTierAction(formData: FormData): Promise<void> {
  const actor = await requireStaff();
  const eventId = String(formData.get("eventId") ?? "");
  const id = String(formData.get("id") ?? "");
  if (!z.uuid().safeParse(id).success) return;

  try {
    await db.delete(sponsorTiers).where(eq(sponsorTiers.id, id));
    await recordAudit({ actor, action: "delete", entity: "sponsor_tiers", entityId: id });
  } catch {
    // Sold sponsorships reference the tier (ON DELETE RESTRICT).
    await db
      .update(sponsorTiers)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(sponsorTiers.id, id));
    await recordAudit({
      actor,
      action: "archive",
      entity: "sponsor_tiers",
      entityId: id,
      metadata: { reason: "tier has sponsorships" },
    });
  }
  revalidatePath(`/admin/events/${eventId}/sponsors`);
}

export async function applySponsorPresetsAction(formData: FormData): Promise<void> {
  const actor = await requireStaff();
  const eventId = String(formData.get("eventId") ?? "");
  if (!z.uuid().safeParse(eventId).success) return;
  const names = formData.getAll("preset").map(String);
  const chosen = SPONSOR_TIER_PRESETS.filter((p) => names.includes(p.name));
  if (!chosen.length) return;

  const existing = await db
    .select({ name: sponsorTiers.name })
    .from(sponsorTiers)
    .where(eq(sponsorTiers.eventId, eventId));
  const have = new Set(existing.map((e) => e.name));
  const toInsert = chosen.filter((p) => !have.has(p.name));
  if (!toInsert.length) return;

  await db.insert(sponsorTiers).values(
    toInsert.map((p) => ({
      eventId,
      name: p.name,
      priceCents: p.priceCents,
      inventory: p.inventory,
      includedTickets: p.includedTickets,
      benefits: p.benefits,
      sortOrder: p.sortOrder,
    })),
  );
  await recordAudit({
    actor,
    action: "create",
    entity: "sponsor_tiers",
    entityId: eventId,
    after: { presets: toInsert.map((p) => p.name) },
    metadata: { via: "preset" },
  });
  revalidatePath(`/admin/events/${eventId}/sponsors`);
}

/* ==================================================================== */
/*  Registrations + check-in                                            */
/* ==================================================================== */

async function refreshEventCounters(eventId: string) {
  await db
    .update(events)
    .set({
      registeredCount: sql`(select count(*)::int from ${registrations} r
        where r.event_id = ${eventId} and r.status <> 'cancelled')`,
      attendedCount: sql`(select count(*)::int from ${registrations} r
        where r.event_id = ${eventId} and r.checked_in_at is not null)`,
    })
    .where(eq(events.id, eventId));
}

/** The door screen. One tap, idempotent, returns fast. */
export async function checkInAction(formData: FormData): Promise<void> {
  const actor = await requireStaff();
  const eventId = String(formData.get("eventId") ?? "");
  const id = String(formData.get("registrationId") ?? "");
  const undo = formData.get("undo") === "true";
  if (!z.uuid().safeParse(id).success) return;

  await db
    .update(registrations)
    .set(
      undo
        ? { checkedInAt: null, checkedInByUserId: null, updatedAt: new Date() }
        : {
            checkedInAt: new Date(),
            checkedInByUserId: actor.userId,
            // Walking through the door confirms a pending registration.
            status: sql`case when ${registrations.status} = 'pending' then 'confirmed'::registration_status else ${registrations.status} end`,
            confirmedAt: sql`coalesce(${registrations.confirmedAt}, now())`,
            updatedAt: new Date(),
          },
    )
    .where(and(eq(registrations.id, id), eq(registrations.eventId, eventId)));

  await refreshEventCounters(eventId);
  await recordAudit({
    actor,
    action: "check-in",
    entity: "registrations",
    entityId: id,
    after: { checkedIn: !undo },
    metadata: { eventId },
  });

  revalidatePath(`/admin/events/${eventId}/checkin`);
  revalidatePath(`/admin/events/${eventId}/registrations`);
}

export async function setRegistrationStatusAction(formData: FormData): Promise<void> {
  const actor = await requireStaff();
  const eventId = String(formData.get("eventId") ?? "");
  const id = String(formData.get("registrationId") ?? "");
  const status = String(formData.get("status") ?? "");
  const allowed = ["pending", "confirmed", "cancelled", "waitlisted"] as const;
  if (!z.uuid().safeParse(id).success) return;
  if (!(allowed as readonly string[]).includes(status)) return;

  const [before] = await db
    .select()
    .from(registrations)
    .where(and(eq(registrations.id, id), eq(registrations.eventId, eventId)))
    .limit(1);
  if (!before) return;

  await db
    .update(registrations)
    .set({
      status: status as (typeof allowed)[number],
      confirmedAt: status === "confirmed" ? (before.confirmedAt ?? new Date()) : before.confirmedAt,
      cancelledAt: status === "cancelled" ? new Date() : null,
      waitlistPosition: status === "waitlisted" ? before.waitlistPosition : null,
      updatedAt: new Date(),
    })
    .where(eq(registrations.id, id));

  await refreshEventCounters(eventId);
  await recordAudit({
    actor,
    action: "status-change",
    entity: "registrations",
    entityId: id,
    before: { status: before.status },
    after: { status },
    metadata: { eventId },
  });

  // Promoting off the waitlist is worth an email.
  if (before.status === "waitlisted" && status === "confirmed") {
    const [event] = await db
      .select({ name: events.name, slug: events.slug })
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);
    if (event) {
      await sendWaitlistPromotion({
        to: before.attendeeEmail,
        attendeeName: before.attendeeName,
        eventName: event.name,
        eventUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/events/${event.slug}`,
      });
    }
  }

  revalidatePath(`/admin/events/${eventId}/registrations`);
  revalidatePath(`/admin/events/${eventId}`);
}

/* ==================================================================== */
/*  Clone                                                               */
/* ==================================================================== */

/**
 * Duplicate an event with its ticket types, sponsor tiers and sessions.
 * WACA runs the same conferences every year; Wild Apricot's Duplicate button
 * is load-bearing, so this copies the shape and none of the people —
 * registrations, sponsorships, counters and invoices are never carried over.
 */
export async function cloneEventAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const parsed = cloneEventSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;

  const newId = await db.transaction(async (tx) => {
    const [source] = await tx
      .select()
      .from(events)
      .where(eq(events.id, input.eventId))
      .limit(1);
    if (!source) throw new Error("Event not found.");

    // Keep the source's internal offsets: registration opens/closes the same
    // number of days before the start date as it did last year.
    const shift = input.startsAt.getTime() - source.startsAt.getTime();
    const shifted = (d: Date | null) => (d ? new Date(d.getTime() + shift) : null);

    const slug = await uniqueSlug(tx, input.slug ?? input.name);

    const copyOne = async (
      src: typeof events.$inferSelect,
      overrides: Partial<typeof events.$inferInsert>,
    ) => {
      const [row] = await tx
        .insert(events)
        .values({
          name: overrides.name ?? src.name,
          slug: overrides.slug as string,
          kind: src.kind,
          // A clone always starts as a draft — never publish by accident.
          status: "draft",
          visibility: src.visibility,
          summary: src.summary,
          description: src.description,
          startsAt: overrides.startsAt ?? input.startsAt,
          endsAt: overrides.endsAt ?? (input.endsAt ?? shifted(src.endsAt)),
          timezone: src.timezone,
          venueName: src.venueName,
          venueAddress: src.venueAddress,
          city: src.city,
          state: src.state,
          isVirtual: src.isVirtual,
          virtualUrl: src.virtualUrl,
          capacity: src.capacity,
          registrationOpensAt: shifted(src.registrationOpensAt),
          registrationClosesAt: shifted(src.registrationClosesAt),
          waitlistEnabled: src.waitlistEnabled,
          councilId: src.councilId,
          contactEmail: src.contactEmail,
          bannerImageUrl: src.bannerImageUrl,
          // Counters and people never come across.
          registeredCount: 0,
          attendedCount: 0,
        })
        .returning({ id: events.id });
      return row.id;
    };

    const clonedId = await copyOne(source, { name: input.name, slug });

    const copyChildren = async (sourceId: string, targetId: string) => {
      if (input.copyTicketTypes) {
        const rows = await tx
          .select()
          .from(ticketTypes)
          .where(eq(ticketTypes.eventId, sourceId));
        if (rows.length) {
          await tx.insert(ticketTypes).values(
            rows.map((t) => ({
              eventId: targetId,
              name: t.name,
              description: t.description,
              priceCents: t.priceCents,
              currency: t.currency,
              capacity: t.capacity,
              soldCount: 0,
              availableFrom: shifted(t.availableFrom),
              availableUntil: shifted(t.availableUntil),
              memberOnly: t.memberOnly,
              levelRestrictions: t.levelRestrictions,
              isInternal: t.isInternal,
              minPerOrder: t.minPerOrder,
              maxPerOrder: t.maxPerOrder,
              sortOrder: t.sortOrder,
              isActive: t.isActive,
            })),
          );
        }
      }
      if (input.copySponsorTiers) {
        const rows = await tx
          .select()
          .from(sponsorTiers)
          .where(eq(sponsorTiers.eventId, sourceId));
        if (rows.length) {
          await tx.insert(sponsorTiers).values(
            rows.map((t) => ({
              eventId: targetId,
              name: t.name,
              priceCents: t.priceCents,
              currency: t.currency,
              benefits: t.benefits,
              inventory: t.inventory,
              soldCount: 0,
              includedTickets: t.includedTickets,
              sortOrder: t.sortOrder,
              isActive: t.isActive,
            })),
          );
        }
      }
      if (input.copySessions) {
        const rows = await tx
          .select()
          .from(eventSessions)
          .where(eq(eventSessions.eventId, sourceId));
        if (rows.length) {
          await tx.insert(eventSessions).values(
            rows.map((s) => ({
              eventId: targetId,
              title: s.title,
              description: s.description,
              startsAt: shifted(s.startsAt)!,
              endsAt: shifted(s.endsAt),
              room: s.room,
              speakers: s.speakers,
              capacity: s.capacity,
              requiresSignup: s.requiresSignup,
              sortOrder: s.sortOrder,
            })),
          );
        }
      }
    };

    await copyChildren(source.id, clonedId);

    // The paired sponsorship event is part of the shape of a conference.
    if (input.copyPairedSponsorshipEvent && source.pairedSponsorshipEventId) {
      const [pairedSource] = await tx
        .select()
        .from(events)
        .where(eq(events.id, source.pairedSponsorshipEventId))
        .limit(1);
      if (pairedSource) {
        const pairedSlug = await uniqueSlug(tx, `${slug}-sponsorship`);
        const pairedId = await copyOne(pairedSource, {
          name: `${input.name} — Sponsorship`,
          slug: pairedSlug,
        });
        await copyChildren(pairedSource.id, pairedId);
        await tx
          .update(events)
          .set({ pairedSponsorshipEventId: pairedId })
          .where(eq(events.id, clonedId));
      }
    }

    await recordAudit({
      db: tx,
      actor,
      action: "create",
      entity: "events",
      entityId: clonedId,
      after: { name: input.name, slug, startsAt: input.startsAt.toISOString() },
      metadata: { clonedFrom: source.id, clonedFromName: source.name },
    });

    return clonedId;
  });

  revalidatePath("/admin/events");
  redirect(`/admin/events/${newId}`);
}

/* ==================================================================== */
/*  Sessions (the multi-session half of a multi-day event)              */
/* ==================================================================== */

export async function saveEventSessionAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const eventId = String(formData.get("eventId") ?? "");
  if (!z.uuid().safeParse(eventId).success) {
    return fail("Unknown event.");
  }
  const parsed = eventSessionSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;

  const values = {
    eventId,
    title: input.title,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    room: input.room,
    requiresSignup: input.requiresSignup,
    capacity: input.capacity,
    sortOrder: input.sortOrder,
  };

  if (input.id) {
    await db
      .update(eventSessions)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(eventSessions.id, input.id), eq(eventSessions.eventId, eventId)));
    await recordAudit({
      actor,
      action: "update",
      entity: "event_sessions",
      entityId: input.id,
      after: values,
    });
  } else {
    const [created] = await db
      .insert(eventSessions)
      .values(values)
      .returning({ id: eventSessions.id });
    await recordAudit({
      actor,
      action: "create",
      entity: "event_sessions",
      entityId: created.id,
      after: values,
    });
  }

  revalidatePath(`/admin/events/${eventId}`);
  return ok("Session saved.");
}

export async function deleteEventSessionAction(formData: FormData): Promise<void> {
  const actor = await requireStaff();
  const eventId = String(formData.get("eventId") ?? "");
  const id = String(formData.get("id") ?? "");
  if (!z.uuid().safeParse(id).success) return;
  await db.delete(eventSessions).where(eq(eventSessions.id, id));
  await recordAudit({ actor, action: "delete", entity: "event_sessions", entityId: id });
  revalidatePath(`/admin/events/${eventId}`);
}
