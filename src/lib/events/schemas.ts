import { z } from "zod";
import { slugify as sharedSlugify } from "@/lib/slug";
import {
  EVENT_KINDS,
  EVENT_STATUSES,
  EVENT_VISIBILITIES,
} from "./format";

/** "" -> null, so an untouched form field clears the column. */
const nullableText = z
  .preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().nullable(),
  )
  .default(null);

const nullableInt = z
  .preprocess((v) => {
    if (v === "" || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : v;
  }, z.number().int().nullable())
  .default(null);

const nullableDate = z
  .preprocess((v) => {
    if (typeof v !== "string" || v.trim() === "") return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d;
  }, z.date().nullable())
  .default(null);

const requiredDate = z.preprocess((v) => {
  if (typeof v === "string" && v.trim() !== "") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d;
  }
  return v;
}, z.date({ message: "A valid start date is required" }));

/** Dollars in the form, integer cents in the database. Never a float in SQL. */
const dollarsToCents = z.preprocess(
  (v) => {
    if (v === "" || v == null) return 0;
    const n = typeof v === "string" ? Number(v.replace(/[$,]/g, "")) : Number(v);
    // Hand the bad value straight through so the number schema reports it
    // with the friendly message below rather than "expected number".
    return Number.isFinite(n) ? Math.round(n * 100) : Number.NaN;
  },
  z
    .number({ error: "Enter a price like 495 or 495.00" })
    .refine((n) => Number.isFinite(n), "Enter a price like 495 or 495.00")
    .refine((n) => n >= 0, "Price cannot be negative"),
);

const checkbox = z.preprocess(
  (v) => v === true || v === "on" || v === "true" || v === "1",
  z.boolean(),
);

/** THE slugifier, capped at the events table's slug length. */
export function slugify(input: string) {
  return sharedSlugify(input, 80);
}

/* --------------------------------------------------------------- event */

export const eventInputSchema = z
  .object({
    name: z.string().trim().min(3, "Give the event a name"),
    slug: z
      .preprocess(
        (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
        z
          .string()
          .trim()
          .regex(/^[a-z0-9-]+$/, "Lowercase letters, numbers and hyphens only")
          .optional(),
      )
      .optional(),
    kind: z.enum(EVENT_KINDS as [string, ...string[]]),
    status: z.enum(EVENT_STATUSES).default("draft"),
    visibility: z.enum(EVENT_VISIBILITIES as [string, ...string[]]),
    summary: nullableText,
    description: nullableText,

    startsAt: requiredDate,
    endsAt: nullableDate,
    timezone: z.string().default("America/Los_Angeles"),

    venueName: nullableText,
    venueAddress: nullableText,
    city: nullableText,
    state: nullableText,
    isVirtual: checkbox.default(false),
    virtualUrl: nullableText,

    capacity: nullableInt,
    registrationOpensAt: nullableDate,
    registrationClosesAt: nullableDate,
    waitlistEnabled: checkbox.default(false),
    /** Convenience flag: creates the event as members-only when set. */
    memberOnly: checkbox.default(false),

    councilId: z
      .preprocess(
        (v) => (typeof v === "string" && v.trim() === "" ? null : v),
        z.uuid().nullable(),
      )
      .default(null),
    contactEmail: z
      .preprocess(
        (v) => (typeof v === "string" && v.trim() === "" ? null : v),
        z.email().nullable(),
      )
      .default(null),
    /** Creates a paired "<name> Sponsorship" event seeded with tier presets. */
    createPairedSponsorship: checkbox.default(false),
  })
  .refine((v) => !v.endsAt || v.endsAt >= v.startsAt, {
    message: "The end date must be on or after the start date",
    path: ["endsAt"],
  })
  .refine(
    (v) =>
      !v.registrationOpensAt ||
      !v.registrationClosesAt ||
      v.registrationClosesAt >= v.registrationOpensAt,
    {
      message: "Registration must close after it opens",
      path: ["registrationClosesAt"],
    },
  );

export type EventInput = z.infer<typeof eventInputSchema>;

/* --------------------------------------------------------- event session */

export const eventSessionSchema = z
  .object({
    id: z.uuid().optional(),
    title: z.string().trim().min(2, "Session needs a title"),
    startsAt: requiredDate,
    endsAt: nullableDate,
    room: nullableText,
    requiresSignup: checkbox.default(false),
    capacity: nullableInt,
    sortOrder: z.coerce.number().int().default(0),
  })
  .refine((v) => !v.endsAt || v.endsAt >= v.startsAt, {
    message: "The session must end after it starts",
    path: ["endsAt"],
  });

/* --------------------------------------------------------- ticket type */

export const ticketTypeSchema = z
  .object({
    id: z.uuid().optional(),
    name: z.string().trim().min(2, "Ticket types need a name"),
    description: nullableText,
    priceCents: dollarsToCents,
    capacity: nullableInt,
    availableFrom: nullableDate,
    availableUntil: nullableDate,
    memberOnly: checkbox.default(false),
    isInternal: checkbox.default(false),
    isActive: checkbox.default(true),
    minPerOrder: z.coerce.number().int().min(1).default(1),
    maxPerOrder: nullableInt,
    sortOrder: z.coerce.number().int().default(0),
  })
  .refine(
    (v) => !v.availableFrom || !v.availableUntil || v.availableUntil >= v.availableFrom,
    { message: "Availability must end after it starts", path: ["availableUntil"] },
  )
  .refine((v) => v.maxPerOrder == null || v.maxPerOrder >= v.minPerOrder, {
    message: "Max per order must be at least the minimum",
    path: ["maxPerOrder"],
  });

export type TicketTypeInput = z.infer<typeof ticketTypeSchema>;

/* --------------------------------------------------------- sponsor tier */

export const sponsorTierSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(2, "Sponsor tiers need a name"),
  priceCents: dollarsToCents,
  inventory: nullableInt,
  includedTickets: z.coerce.number().int().min(0).default(0),
  /** One benefit per line in the textarea. */
  benefits: z
    .preprocess(
      (v) =>
        typeof v === "string"
          ? v
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean)
          : Array.isArray(v)
            ? v
            : [],
      z.array(z.string()),
    )
    .default([]),
  isActive: checkbox.default(true),
  sortOrder: z.coerce.number().int().default(0),
});

export type SponsorTierInput = z.infer<typeof sponsorTierSchema>;

/* ----------------------------------------------------------- clone */

export const cloneEventSchema = z.object({
  eventId: z.uuid(),
  name: z.string().trim().min(3, "Give the copy a name"),
  slug: z
    .preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z
        .string()
        .trim()
        .regex(/^[a-z0-9-]+$/, "Lowercase letters, numbers and hyphens only")
        .optional(),
    )
    .optional(),
  startsAt: requiredDate,
  endsAt: nullableDate,
  copyTicketTypes: checkbox.default(true),
  copySponsorTiers: checkbox.default(true),
  copySessions: checkbox.default(true),
  copyPairedSponsorshipEvent: checkbox.default(true),
});

/* ------------------------------------------------------- registration */

export const registrationLineSchema = z.object({
  ticketTypeId: z.uuid(),
  quantity: z.coerce.number().int().min(0).max(50),
});

export const publicRegistrationSchema = z.object({
  eventId: z.uuid(),
  attendeeName: z.string().trim().min(2, "Tell us who is attending"),
  attendeeEmail: z.email("A valid email address is required"),
  attendeeTitle: nullableText,
  attendeeOrganizationName: nullableText,
  dietaryNotes: nullableText,
  accessibilityNotes: nullableText,
  /** JSON array of { ticketTypeId, quantity } from the form. */
  lines: z.preprocess((v) => {
    if (typeof v === "string") {
      try {
        return JSON.parse(v);
      } catch {
        return [];
      }
    }
    return v;
  }, z.array(registrationLineSchema).min(1, "Choose at least one ticket")),
  /** Guest rows: [{ name, email?, ticketTypeId }] */
  guests: z
    .preprocess(
      (v) => {
        if (typeof v === "string") {
          try {
            return JSON.parse(v);
          } catch {
            return [];
          }
        }
        return v ?? [];
      },
      z.array(
        z.object({
          name: z.string().trim().min(1),
          email: z
            .preprocess(
              (v) => (typeof v === "string" && v.trim() === "" ? null : v),
              z.email().nullable(),
            )
            .default(null),
          ticketTypeId: z.uuid().optional(),
          notes: nullableText,
        }),
      ),
    )
    .default([]),
});

export type PublicRegistrationInput = z.infer<typeof publicRegistrationSchema>;
