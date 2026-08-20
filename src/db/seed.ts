/**
 * ============================================================================
 *  SYNTHETIC SEED  --  src/db/seed.ts
 *
 *  Produces a realistic, demonstrable WACA account with ZERO real data.
 *
 *  * Every name, email, organisation and licence number below is INVENTED.
 *    All email addresses are @example.org.
 *  * Real WACA member records arrive through the separate Wild Apricot
 *    importer, which is an explicit, key-gated step and NOT part of this file.
 *    Nothing here fetches, scrapes, or approximates a real contact record.
 *  * The shape of the account -- level fees, bundle counts, status mix, event
 *    kinds, venues, ticket-type and sponsor-tier vocabularies -- mirrors what
 *    was verified in the live Wild Apricot admin, so the UI has something
 *    truthful to lay out against.
 *
 *  IDEMPOTENT: truncates every application table, then inserts from a fixed
 *  PRNG seed. Run it as many times as you like; you get byte-identical data.
 *
 *      npm run db:seed      -- re-seed in place
 *      npm run db:reset     -- drop schema, replay migrations, re-seed
 *
 *  Replacing it with real data: delete nothing. Point the importer at the
 *  database and let it upsert; then set NEXT_PUBLIC_IS_DEMO_DATA=false so the
 *  demo banner disappears.
 * ============================================================================
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { scryptSync, randomBytes } from "node:crypto";

import * as s from "./schema";

/** Surfaced by the UI so nobody mistakes seed rows for production records. */
export const IS_DEMO_DATA = true;

const EMAIL_DOMAIN = "example.org";

/* ------------------------------------------------------------------ rng */

/** mulberry32 -- small, fast, deterministic. */
function makeRng(seed: number) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = makeRng(20260819);

const int = (min: number, max: number) =>
  Math.floor(rng() * (max - min + 1)) + min;
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
const chance = (p: number) => rng() < p;

/** Deterministic v4-shaped uuid from the seeded PRNG. */
function uid(): string {
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = Math.floor(rng() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ----------------------------------------------------------------- dates */

const TODAY = new Date("2026-08-19T12:00:00Z");
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) =>
  new Date(d.getTime() + n * 86400000);
const addYears = (d: Date, n: number) => {
  const x = new Date(d);
  x.setUTCFullYear(x.getUTCFullYear() + n);
  return x;
};

function slugify(v: string) {
  return v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/* ============================================================ vocabulary */

/** The 10 real membership levels with the real fees, in cents. */
const LEVELS = [
  {
    key: "admin",
    name: "Admin",
    type: "admin" as const,
    feeCents: 0,
    billingPeriod: "lifetime" as const,
    renewalAnchor: "join_date" as const,
    publicApplications: false,
    revenueBand: null,
    min: null,
    max: null,
    description: "Internal WACA staff and board access. Lifetime, no fee.",
  },
  {
    key: "full-1",
    name: "Full Membership - Level 1",
    type: "full" as const,
    feeCents: 630_000,
    billingPeriod: "annual" as const,
    renewalAnchor: "join_date" as const,
    publicApplications: true,
    revenueBand: "over-5m" as const,
    min: 500_000_000,
    max: null,
    description: "Licensed cannabis businesses with annual revenue over $5M.",
  },
  {
    key: "full-2",
    name: "Full Membership - Level 2",
    type: "full" as const,
    feeCents: 315_000,
    billingPeriod: "annual" as const,
    renewalAnchor: "join_date" as const,
    publicApplications: true,
    revenueBand: "1m-4.9m" as const,
    min: 100_000_000,
    max: 490_000_000,
    description: "Licensed cannabis businesses with annual revenue $1M-$4.9M.",
  },
  {
    key: "full-3",
    name: "Full Membership - Level 3",
    type: "full" as const,
    feeCents: 210_000,
    billingPeriod: "annual" as const,
    renewalAnchor: "join_date" as const,
    publicApplications: true,
    revenueBand: "150k-1m" as const,
    min: 15_000_000,
    max: 100_000_000,
    description: "Licensed cannabis businesses with annual revenue $150k-$1M.",
  },
  {
    key: "full-4",
    name: "Full Membership - Level 4",
    type: "full" as const,
    feeCents: 52_500,
    billingPeriod: "annual" as const,
    renewalAnchor: "join_date" as const,
    publicApplications: true,
    revenueBand: "under-150k" as const,
    min: null,
    max: 15_000_000,
    description: "Licensed cannabis businesses with annual revenue under $150k.",
  },
  {
    key: "assoc-1",
    name: "Associate Membership - Level 1",
    type: "associate" as const,
    feeCents: 630_000,
    billingPeriod: "annual" as const,
    renewalAnchor: "join_date" as const,
    publicApplications: true,
    revenueBand: "over-5m" as const,
    min: 500_000_000,
    max: null,
    description: "Non-licensed businesses serving the industry, revenue over $5M.",
  },
  {
    key: "assoc-2",
    name: "Associate Membership - Level 2",
    type: "associate" as const,
    feeCents: 252_000,
    billingPeriod: "annual" as const,
    renewalAnchor: "join_date" as const,
    publicApplications: true,
    revenueBand: "under-1m" as const,
    min: 100_000_000,
    max: 490_000_000,
    description: "Non-licensed businesses serving the industry, revenue $1M-$4.9M.",
  },
  {
    key: "assoc-3",
    name: "Associate Membership - Level 3",
    type: "associate" as const,
    feeCents: 120_700,
    billingPeriod: "annual" as const,
    renewalAnchor: "join_date" as const,
    publicApplications: true,
    revenueBand: "under-1m" as const,
    min: null,
    max: 100_000_000,
    description: "Non-licensed businesses serving the industry, revenue under $1M.",
  },
  {
    key: "limited",
    name: "Limited Membership",
    type: "limited" as const,
    feeCents: 52_500,
    billingPeriod: "annual" as const,
    renewalAnchor: "join_date" as const,
    publicApplications: true,
    revenueBand: "under-150k" as const,
    min: null,
    max: 15_000_000,
    description: "Entry-level membership for very small operators and start-ups.",
  },
  {
    key: "monthly-full",
    name: "Monthly Full Membership",
    type: "monthly" as const,
    feeCents: 500_000,
    billingPeriod: "monthly" as const,
    renewalAnchor: "calendar" as const,
    publicApplications: false,
    revenueBand: "over-5m" as const,
    min: 500_000_000,
    max: null,
    description:
      "Invitation-only monthly billing, renews on the 1st. Not offered publicly.",
  },
];

const CATEGORY_PLAN = [
  { category: "retailer" as const, count: 18 },
  { category: "producer-processor" as const, count: 19 },
  { category: "lab-transport" as const, count: 3 },
  { category: "ancillary" as const, count: 14 },
]; // = 54 bundles

const RETAIL_NAMES = [
  "Cascade Green", "Rainier Leaf", "Emerald Row", "Puget Provisions",
  "Sound Botanicals", "Northgate Naturals", "Ballard Bud Co", "Olympic Coast Cannabis",
  "Skagit Valley Dispensary", "Chinook Collective", "Salish Sea Supply",
  "Tacoma Terpene House", "Yakima Gold Retail", "Spokane Sunrise Cannabis",
  "Bellingham Botanic", "Kitsap Canopy", "Wenatchee Wellness", "Vancouver Verde",
];
const PRODUCER_NAMES = [
  "Columbia Basin Growers", "Palouse Craft Cannabis", "Methow Mountain Farms",
  "Chehalis River Cultivation", "Snoqualmie Sun Grown", "Okanogan Organics",
  "Willapa Bay Botanicals", "Kittitas Craft Co", "Whidbey Farmhouse",
  "Ellensburg Extracts", "Grays Harbor Growers", "Walla Walla Wellness Farms",
  "Klickitat Cultivars", "Nooksack Nursery", "Stevens Pass Provisions",
  "Cowlitz Cannabis Works", "Douglas County Cultivation", "Franklin Field Farms",
  "Adams County Agronomy",
];
const LAB_NAMES = [
  "Evergreen Analytics Lab", "Pacific Compliance Testing", "Cascadia Secure Transport",
];
const ANCILLARY_NAMES = [
  "Rainshadow Legal Group", "Northwest Packaging Partners", "Sound Payroll Services",
  "Cedar & Co Accounting", "Foghorn Marketing", "Puget Insurance Brokers",
  "Summit Compliance Advisors", "Harborview Real Estate", "Trailhead Software",
  "Basalt Security Systems", "Alki Point Consulting", "Dungeness Design Studio",
  "Mount Baker Logistics", "Deception Pass Capital",
];

const FIRST_NAMES = [
  "Avery","Bennett","Camille","Dashiell","Elena","Felix","Georgia","Hollis",
  "Imogen","Jasper","Kendra","Lucian","Marisol","Nolan","Odette","Priya",
  "Quinn","Rosalind","Soren","Tamsin","Ulises","Verity","Wendell","Xiomara",
  "Yusuf","Zora","Adrian","Beatrix","Callum","Delphine","Emmett","Fiona",
  "Gideon","Harriet","Ines","Julian","Kaia","Leonard","Mireille","Nils",
];
const LAST_NAMES = [
  "Abernathy","Blackwood","Castellanos","Devereux","Ellingsworth","Fairbanks",
  "Grimaldi","Holloway","Ivarsson","Jenkinson","Kowalczyk","Lindqvist",
  "Mackenzie","Nakamura","Ostrowski","Pemberton","Quintanilla","Rasmussen",
  "Stavropoulos","Thorncroft","Underwood","Vasquez","Whitlock","Xanthopoulos",
  "Yarborough","Zieliński","Ashcombe","Brennagh","Cavendish","Dunmore",
];
const TITLES = [
  "Owner","Chief Executive Officer","General Manager","Director of Compliance",
  "Head of Operations","Controller","Government Affairs Lead","Retail Director",
  "Cultivation Manager","Chief Financial Officer","Marketing Director",
  "Partner","Counsel","Vice President","Regional Manager",
];

const VENUES = [
  { venueName: "Marcus Whitman Hotel", venueAddress: "6 W Rose St", city: "Walla Walla" },
  { venueName: "Columbia Tower Club", venueAddress: "701 5th Ave, 75th Floor", city: "Seattle" },
  { venueName: "Hotel RL Olympia", venueAddress: "2300 Evergreen Park Dr SW", city: "Olympia" },
  { venueName: "Washington State Capitol Campus", venueAddress: "416 Sid Snyder Ave SW", city: "Olympia" },
  { venueName: "The Conservatory", venueAddress: "500 Wall St", city: "Seattle" },
  { venueName: "Wine Valley Golf Club", venueAddress: "176 Wine Valley Rd", city: "Walla Walla" },
];

const CONFERENCE_TICKETS = [
  { name: "Full Event Registration with Wine", priceCents: 89_500 },
  { name: "Event Registration - No Wine Tasting", priceCents: 69_500 },
  { name: "Wine Tour Guest", priceCents: 45_000 },
  { name: "Speaker", priceCents: 0, isInternal: true },
  { name: "Sponsor Attendee", priceCents: 0, isInternal: true },
  { name: "Staff", priceCents: 0, isInternal: true },
];
const STANDARD_TICKETS = [
  { name: "Attendee", priceCents: 7_500 },
  { name: "Speaker", priceCents: 0, isInternal: true },
  { name: "Staff", priceCents: 0, isInternal: true },
];
const FUNDRAISER_TICKETS = [
  { name: "Attendee", priceCents: 100_000 },
  { name: "Staff", priceCents: 0, isInternal: true },
];
const SPONSORSHIP_TICKETS = [
  { name: "Sponsor Attendee", priceCents: 0, isInternal: true },
];

const SPONSOR_TIERS = [
  { name: "Diamond", priceCents: 2_500_000, inventory: 1, includedTickets: 8 },
  { name: "Platinum", priceCents: 1_500_000, inventory: 2, includedTickets: 6 },
  { name: "Gold", priceCents: 1_000_000, inventory: 4, includedTickets: 4 },
  { name: "Silver", priceCents: 500_000, inventory: 6, includedTickets: 2 },
  { name: "Coffee", priceCents: 250_000, inventory: 2, includedTickets: 2 },
  { name: "Lunch", priceCents: 350_000, inventory: 2, includedTickets: 2 },
  { name: "Breakfast", priceCents: 300_000, inventory: 2, includedTickets: 2 },
  { name: "Cocktail", priceCents: 400_000, inventory: 2, includedTickets: 2 },
  { name: "Wine", priceCents: 350_000, inventory: 3, includedTickets: 2 },
  { name: "Lanyard", priceCents: 200_000, inventory: 1, includedTickets: 1 },
  { name: "Hole", priceCents: 100_000, inventory: 18, includedTickets: 1 },
  { name: "Swag Bag", priceCents: 150_000, inventory: 1, includedTickets: 1 },
];

const COUNCILS = [
  {
    slug: "retail",
    name: "Retail Sector Council",
    licenses: ["retail"] as const,
    description:
      "Licensed retailers. Elevates retail policy priorities to the annual policy meeting.",
  },
  {
    slug: "producers",
    name: "Producers Sector Council",
    licenses: ["producer", "producer-processor"] as const,
    description:
      "Licensed producers. Elevates cultivation policy priorities to the annual policy meeting.",
  },
  {
    slug: "processors",
    name: "Processors Sector Council",
    licenses: ["processor", "producer-processor"] as const,
    description:
      "Licensed processors. Elevates processing and product policy priorities.",
  },
  {
    slug: "lab",
    name: "Lab Sector Council",
    licenses: ["lab"] as const,
    description:
      "Certified testing laboratories. Elevates testing-standard priorities.",
  },
];

/* ============================================================== main */

async function main() {
  const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = postgres(url, { max: 1, prepare: false });
  const db = drizzle(client, { schema: s, casing: "snake_case" });

  console.log("WACA synthetic seed  (IS_DEMO_DATA = true)\n");

  /* ---------------------------------------------------------- truncate */
  await db.execute(sql`
    TRUNCATE TABLE
      audit_log, document_downloads, documents,
      payment_allocations, refunds, payments, invoice_lines, invoices,
      event_sponsorships, registrations, sponsor_tiers, ticket_types,
      event_sessions, events,
      council_priorities, council_members, councils,
      renewal_reminders, renewal_reminder_rules,
      membership_applications, memberships, membership_levels,
      contact_fields, contacts, organizations,
      authenticators, sessions, accounts, verification_tokens, users
    RESTART IDENTITY CASCADE
  `);

  /* ------------------------------------------------------------ levels */
  const levelRows = LEVELS.map((l, i) => ({
    id: uid(),
    name: l.name,
    slug: l.key,
    type: l.type,
    feeCents: l.feeCents,
    billingPeriod: l.billingPeriod,
    renewalAnchor: l.renewalAnchor,
    renewalAnchorDay: l.billingPeriod === "monthly" ? 1 : null,
    publicApplications: l.publicApplications,
    // Verified live: auto-renew is OFF on every level in Wild Apricot.
    // Kept false here so the "revenue leak" dashboard has something real to
    // show; the platform supports flipping it per level and per member.
    autoRenewDefault: false,
    revenueBandMinCents: l.min,
    revenueBandMaxCents: l.max,
    revenueBand: l.revenueBand,
    description: l.description,
    benefits: [
      "Legislative bill tracking and weekly Detail Report",
      "Sector council participation",
      "Member rates on all WACA events",
    ],
    sortOrder: i,
    isActive: true,
  }));
  await db.insert(s.membershipLevels).values(levelRows);
  const levelBySlug = new Map(levelRows.map((l) => [l.slug, l]));

  /* --------------------------------------------- reminder ladder rules */
  const reminderRules = [
    { offsetKind: "before-expiry" as const, offsetDays: 60, templateKey: "renewal-60-day", subject: "Your WACA membership renews in 60 days" },
    { offsetKind: "before-expiry" as const, offsetDays: 30, templateKey: "renewal-30-day", subject: "Your WACA membership renews in 30 days" },
    { offsetKind: "before-expiry" as const, offsetDays: 7, templateKey: "renewal-7-day", subject: "Your WACA membership renews next week" },
    { offsetKind: "after-expiry" as const, offsetDays: 7, templateKey: "lapsed-7-day", subject: "Your WACA membership has expired" },
    { offsetKind: "after-expiry" as const, offsetDays: 30, templateKey: "lapsed-30-day", subject: "Reinstate your WACA membership" },
  ].map((r, i) => ({
    id: uid(),
    name: `${r.offsetKind === "before-expiry" ? "T-" : "T+"}${r.offsetDays} days`,
    levelId: null,
    offsetKind: r.offsetKind,
    offsetDays: r.offsetDays,
    channel: "email" as const,
    templateKey: r.templateKey,
    subject: r.subject,
    isActive: true,
    sortOrder: i,
  }));
  await db.insert(s.renewalReminderRules).values(reminderRules);

  /* ---------------------------------------------------- custom fields */
  const contactFieldRows = [
    { key: "wslcb_license", label: "WSLCB License Number", type: "text" as const, appliesTo: "organization" },
    { key: "years_in_industry", label: "Years in Industry", type: "number" as const, appliesTo: "contact" },
    { key: "dietary_needs", label: "Dietary Needs", type: "text" as const, appliesTo: "contact" },
    { key: "committee_interest", label: "Committee Interest", type: "multiselect" as const, appliesTo: "contact",
      options: [
        { value: "policy", label: "Policy" },
        { value: "events", label: "Events" },
        { value: "membership", label: "Membership" },
      ] },
    { key: "preferred_pronouns", label: "Preferred Pronouns", type: "text" as const, appliesTo: "contact" },
    { key: "newsletter_format", label: "Newsletter Format", type: "select" as const, appliesTo: "contact",
      options: [
        { value: "html", label: "HTML" },
        { value: "plain", label: "Plain text" },
      ] },
  ].map((f, i) => ({
    id: uid(),
    key: f.key,
    label: f.label,
    type: f.type,
    options: f.options ?? [],
    helpText: null,
    required: false,
    memberVisible: true,
    memberEditable: f.appliesTo === "contact",
    appliesTo: f.appliesTo,
    sortOrder: i,
  }));
  await db.insert(s.contactFields).values(contactFieldRows);

  /* ---------------------------------------------------------- councils */
  const councilRows = COUNCILS.map((c, i) => ({
    id: uid(),
    name: c.name,
    slug: c.slug,
    description: c.description,
    autoEnrollLicenseTypes: [...c.licenses],
    staffLiaisonContactId: null,
    isActive: true,
    sortOrder: i,
  }));
  await db.insert(s.councils).values(councilRows);
  const councilBySlug = new Map(councilRows.map((c) => [c.slug, c]));

  /* ----------------------------------------------------- organisations */
  type OrgSeed = {
    id: string;
    legalName: string;
    displayName: string;
    slug: string;
    category: "retailer" | "producer-processor" | "lab-transport" | "ancillary";
    licenseTypes: ("retail" | "producer" | "processor" | "producer-processor" | "lab" | "transport" | "none")[];
  };

  const namePools: Record<string, string[]> = {
    retailer: [...RETAIL_NAMES],
    "producer-processor": [...PRODUCER_NAMES],
    "lab-transport": [...LAB_NAMES],
    ancillary: [...ANCILLARY_NAMES],
  };
  const suffixFor: Record<string, string> = {
    retailer: "LLC",
    "producer-processor": "LLC",
    "lab-transport": "Inc.",
    ancillary: "LLC",
  };

  const orgSeeds: OrgSeed[] = [];
  for (const plan of CATEGORY_PLAN) {
    for (let i = 0; i < plan.count; i++) {
      const base = namePools[plan.category][i];
      const licenseTypes: OrgSeed["licenseTypes"] =
        plan.category === "retailer"
          ? ["retail"]
          : plan.category === "producer-processor"
            ? chance(0.5)
              ? ["producer", "processor"]
              : chance(0.5)
                ? ["producer"]
                : ["processor"]
            : plan.category === "lab-transport"
              ? base.includes("Transport")
                ? ["transport"]
                : ["lab"]
              : ["none"];
      orgSeeds.push({
        id: uid(),
        legalName: `${base} ${suffixFor[plan.category]}`,
        displayName: base,
        slug: slugify(base),
        category: plan.category,
        licenseTypes,
      });
    }
  }

  /* ------------------------------------------------- membership plan --
   * 54 bundles. Level mix mirrors the live account: Full Membership
   * Level 1 dominates at 45 of 54, the remaining 9 spread one apiece
   * across the other paid levels. (The Admin level carries no bundle --
   * it is staff-only.)
   *
   * Status mix, also from the live account:
   *   42 active | 2 renewal-overdue | 7 pending-renewal
   *    1 pending-new | 2 pending-level-change              = 54
   */
  const levelPlan: string[] = [
    ...Array(45).fill("full-1"),
    "full-2", "full-2", "full-3", "full-4",
    "assoc-1", "assoc-2", "assoc-3", "limited", "monthly-full",
  ];
  type MembershipStatus = (typeof s.membershipStatusEnum.enumValues)[number];
  const statusPlan: MembershipStatus[] = [
    ...Array(42).fill("active"),
    "renewal-overdue", "renewal-overdue",
    ...Array(7).fill("pending-renewal"),
    "pending-new",
    "pending-level-change", "pending-level-change",
  ] as MembershipStatus[];

  const orgInserts: (typeof s.organizations.$inferInsert)[] = [];
  const membershipInserts: (typeof s.memberships.$inferInsert)[] = [];
  const contactInserts: (typeof s.contacts.$inferInsert)[] = [];

  type ContactSeed = {
    id: string;
    orgId: string;
    name: string;
    email: string;
    isPrimary: boolean;
    isBundleAdmin: boolean;
  };
  const contactSeeds: ContactSeed[] = [];
  const usedEmails = new Set<string>();

  orgSeeds.forEach((org, idx) => {
    const levelSlug = levelPlan[idx];
    const status = statusPlan[idx];
    const level = levelBySlug.get(levelSlug)!;

    const yearsAgo = int(1, 9);
    const memberSince = addDays(addYears(TODAY, -yearsAgo), -int(0, 200));

    // Term boundaries consistent with the status.
    let termStart: Date;
    let expires: Date;
    if (status === "renewal-overdue") {
      expires = addDays(TODAY, -int(10, 45));
      termStart = addYears(expires, -1);
    } else if (status === "pending-renewal") {
      expires = addDays(TODAY, -int(1, 25));
      termStart = addYears(expires, -1);
    } else if (status === "pending-new") {
      termStart = addDays(TODAY, -int(2, 14));
      expires = addYears(termStart, 1);
    } else if (level.billingPeriod === "monthly") {
      termStart = new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), 1));
      expires = new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth() + 1, 1));
    } else {
      // Active / pending-level-change: expiry spread over the coming year so
      // the 90-day renewal dashboard has a realistic population.
      expires = addDays(TODAY, int(3, 360));
      termStart = addYears(expires, -1);
    }

    const revenueBand =
      level.revenueBand ?? ("not-disclosed" as const);

    orgInserts.push({
      id: org.id,
      legalName: org.legalName,
      displayName: org.displayName,
      slug: org.slug,
      category: org.category,
      revenueBand,
      licenseNumbers:
        org.licenseTypes[0] === "none"
          ? []
          : [`${int(100000, 999999)}-${int(1, 9)}`],
      licenseTypes: org.licenseTypes,
      website: `https://www.${org.slug}.${EMAIL_DOMAIN}`,
      logoUrl: null,
      logoFileKey: null,
      phone: `(206) 555-${String(int(1000, 9999))}`,
      email: `info@${org.slug}.${EMAIL_DOMAIN}`,
      addressLine1: `${int(100, 9999)} ${pick(["Pine", "Cedar", "Alder", "Madrona", "Fir", "Juniper"])} ${pick(["St", "Ave", "Way", "Blvd"])}`,
      addressLine2: chance(0.2) ? `Suite ${int(100, 900)}` : null,
      city: pick(["Seattle", "Tacoma", "Olympia", "Spokane", "Bellingham", "Yakima", "Vancouver", "Walla Walla"]),
      state: "WA",
      postalCode: String(int(98001, 99403)),
      country: "US",
      publicListingConsent: chance(0.72),
      publicDescription: `${org.displayName} is a Washington ${org.category.replace("-", " / ")} business and a WACA member. (Demo data.)`,
      memberSince,
      notes: null,
    });

    const membershipId = uid();
    membershipInserts.push({
      id: membershipId,
      organizationId: org.id,
      levelId: level.id,
      status,
      joinedOn: iso(memberSince),
      termStartsOn: iso(termStart),
      expiresOn: iso(expires),
      // Auto-renew is off almost everywhere, exactly as in Wild Apricot.
      // A handful are on so the UI shows both states.
      autoRenew: chance(0.09),
      renewalRemindersSent:
        status === "renewal-overdue" ? int(3, 4) : status === "pending-renewal" ? int(1, 3) : 0,
      lastReminderSentAt:
        status === "renewal-overdue" || status === "pending-renewal"
          ? addDays(TODAY, -int(2, 30))
          : null,
      isCurrent: true,
      feeChargedCents: level.feeCents,
      notes: null,
    });

    // Contacts: active bundles carry ~2 people, non-active carry ~1.
    // Totals land on 96 contacts, 86 of them inside 'active' bundles.
    const contactCount = status === "active" ? (idx % 21 === 0 ? 3 : 2) : 1;
    for (let c = 0; c < contactCount; c++) {
      const first = pick(FIRST_NAMES);
      const last = pick(LAST_NAMES);
      let email = `${first}.${last}@${org.slug}.${EMAIL_DOMAIN}`.toLowerCase();
      let n = 2;
      while (usedEmails.has(email)) {
        email = `${first}.${last}${n++}@${org.slug}.${EMAIL_DOMAIN}`.toLowerCase();
      }
      usedEmails.add(email);
      const id = uid();
      // Draw ONCE -- contactSeeds and contactInserts must agree, or the
      // bundle-admin RLS policy will disagree with the demo logins.
      const isBundleAdmin = c === 0 || (c === 1 && chance(0.25));
      contactSeeds.push({
        id,
        orgId: org.id,
        name: `${first} ${last}`,
        email,
        isPrimary: c === 0,
        isBundleAdmin,
      });
      contactInserts.push({
        id,
        firstName: first,
        lastName: last,
        displayName: `${first} ${last}`,
        email,
        phone: `(206) 555-${String(int(1000, 9999))}`,
        mobile: chance(0.5) ? `(425) 555-${String(int(1000, 9999))}` : null,
        title: pick(TITLES),
        organizationId: org.id,
        isBundleAdmin,
        isPrimaryContact: c === 0,
        userId: null,
        contactFieldValues: {
          years_in_industry: int(1, 12),
          newsletter_format: chance(0.7) ? "html" : "plain",
          ...(chance(0.25) ? { dietary_needs: pick(["Vegetarian", "Gluten free", "No shellfish"]) } : {}),
        },
        // Synthetic member tags. Real tags arrive with the Wild Apricot
        // importer; these exist only so /admin/contacts?tag=... is demonstrable.
        tags: [
          ...(isBundleAdmin ? ["bundle-admin"] : []),
          ...(c === 0 ? ["billing-contact"] : []),
          ...(chance(0.28) ? ["policy-committee"] : []),
          ...(chance(0.22) ? ["events-committee"] : []),
          ...(chance(0.18) ? ["newsletter"] : []),
          ...(chance(0.12) ? ["board-prospect"] : []),
          ...(chance(0.1) ? ["do-not-call"] : []),
        ],
        emailOptIn: chance(0.93),
        directoryOptIn: chance(0.6),
        notes: null,
      });
    }
  });

  /*
   * Live member-record count.
   *   42 active bundles  -> 86 contacts   (the real "86 active")
   *   12 non-active      -> 12 contacts
   * Two of the renewal-overdue bundles lost their only staffer, so their
   * contact is archived rather than deleted -- exactly what the Wild Apricot
   * export looks like. Live member records: 86 + 10 = 96.
   */
  const overdueOrgIds = membershipInserts
    .filter((m) => m.status === "renewal-overdue")
    .map((m) => m.organizationId as string);
  for (const orgId of overdueOrgIds) {
    const c = contactInserts.find((x) => x.organizationId === orgId);
    if (c) {
      c.archivedAt = addDays(TODAY, -int(30, 200));
      c.isPrimaryContact = false;
      c.notes = "Archived: no longer with the organisation. (Demo data.)";
    }
  }

  await db.insert(s.organizations).values(orgInserts);
  await db.insert(s.memberships).values(membershipInserts);
  await db.insert(s.contacts).values(contactInserts);

  // Prior terms, so the member page has a membership history and the
  // 'lapsed' status is represented somewhere in the account.
  const priorTerms: (typeof s.memberships.$inferInsert)[] = [];
  membershipInserts.slice(0, 8).forEach((m, i) => {
    const start = addYears(new Date(m.termStartsOn as string), -2);
    priorTerms.push({
      id: uid(),
      organizationId: m.organizationId as string,
      levelId: m.levelId as string,
      status: i < 3 ? "lapsed" : "active",
      joinedOn: m.joinedOn as string,
      termStartsOn: iso(start),
      expiresOn: iso(addYears(start, 1)),
      autoRenew: false,
      renewalRemindersSent: 5,
      isCurrent: false,
      feeChargedCents: m.feeChargedCents as number,
      lapsedOn: i < 3 ? iso(addYears(start, 1)) : null,
      notes: "Prior term. (Demo data.)",
    });
  });
  await db.insert(s.memberships).values(priorTerms);

  const orgById = new Map(orgSeeds.map((o) => [o.id, o]));
  const membershipByOrg = new Map(
    membershipInserts.map((m) => [m.organizationId as string, m]),
  );

  /* ------------------------------------------------ council enrolment */
  const councilMemberInserts: (typeof s.councilMembers.$inferInsert)[] = [];
  for (const contact of contactSeeds) {
    const org = orgById.get(contact.orgId)!;
    // One delegate per organisation per council: the primary contact.
    if (!contact.isPrimary) continue;
    for (const council of councilRows) {
      const match = org.licenseTypes.find((lt) =>
        (council.autoEnrollLicenseTypes as string[]).includes(lt),
      );
      if (!match) continue;
      councilMemberInserts.push({
        id: uid(),
        councilId: council.id,
        contactId: contact.id,
        organizationId: org.id,
        role: "member",
        autoEnrolled: true,
        enrolledViaLicenseType: match,
        joinedOn: iso(addDays(TODAY, -int(60, 900))),
        isActive: true,
      });
    }
  }
  // Promote one chair per council.
  for (const council of councilRows) {
    const first = councilMemberInserts.find((cm) => cm.councilId === council.id);
    if (first) first.role = "chair";
  }
  await db.insert(s.councilMembers).values(councilMemberInserts);

  const priorityInserts = councilRows.flatMap((c, ci) =>
    [
      "Streamline WSLCB license transfer review timelines",
      "Align local zoning rules with state licensing",
      "Modernise testing thresholds and lab proficiency standards",
    ].map((title, i) => ({
      id: uid(),
      councilId: c.id,
      title,
      summary: `${c.name} priority for the 2027 session. (Demo data.)`,
      policyYear: 2027,
      rank: i + 1,
      status: i === 0 ? "elevated" : "proposed",
      relatedBills: i === 0 ? [`HB ${1200 + ci * 7}`] : [],
      elevatedAt: i === 0 ? addDays(TODAY, -int(20, 90)) : null,
    })),
  );
  await db.insert(s.councilPriorities).values(priorityInserts);

  /* ------------------------------------------------------- applications */
  const applicationInserts: (typeof s.membershipApplications.$inferInsert)[] = [];
  for (const m of membershipInserts) {
    const status = m.status as string;
    if (!["pending-new", "pending-renewal", "pending-level-change"].includes(status))
      continue;
    const primary = contactSeeds.find(
      (c) => c.orgId === m.organizationId && c.isPrimary,
    );
    const type =
      status === "pending-new"
        ? ("new" as const)
        : status === "pending-renewal"
          ? ("renewal" as const)
          : ("level-change" as const);
    const requested =
      type === "level-change"
        ? levelBySlug.get("full-2")!.id
        : (m.levelId as string);
    applicationInserts.push({
      id: uid(),
      type,
      status: "submitted",
      organizationId: m.organizationId as string,
      membershipId: type === "new" ? null : (m.id as string),
      requestedLevelId: requested,
      currentLevelId: type === "new" ? null : (m.levelId as string),
      submittedByContactId: primary?.id ?? null,
      applicantPayload: {
        declared_revenue: "Demo data - synthetic application",
        source: "seed",
      },
      declaredRevenueBand: "not-disclosed",
      submittedAt: addDays(TODAY, -int(1, 21)),
    });
  }
  await db.insert(s.membershipApplications).values(applicationInserts);

  /* ------------------------------------------------------------ events */
  type EventSeed = typeof s.events.$inferInsert & { id: string };
  const eventInserts: EventSeed[] = [];
  const ticketInserts: (typeof s.ticketTypes.$inferInsert)[] = [];
  const sessionInserts: (typeof s.eventSessions.$inferInsert)[] = [];
  const tierInserts: (typeof s.sponsorTiers.$inferInsert)[] = [];

  function addTickets(eventId: string, kind: string) {
    const set =
      kind === "conference"
        ? CONFERENCE_TICKETS
        : kind === "fundraiser"
          ? FUNDRAISER_TICKETS
          : kind === "sponsorship"
            ? SPONSORSHIP_TICKETS
            : STANDARD_TICKETS;
    const rows = set.map((t, i) => ({
      id: uid(),
      eventId,
      name: t.name,
      description: null,
      priceCents: t.priceCents,
      capacity: null,
      soldCount: 0,
      memberOnly: t.priceCents > 0 && kind === "conference" ? false : false,
      levelRestrictions: [],
      isInternal: Boolean((t as { isInternal?: boolean }).isInternal),
      minPerOrder: 1,
      maxPerOrder: 10,
      sortOrder: i,
      isActive: true,
    }));
    ticketInserts.push(...rows);
    return rows;
  }

  function addTiers(eventId: string) {
    const rows = SPONSOR_TIERS.map((t, i) => ({
      id: uid(),
      eventId,
      name: t.name,
      priceCents: t.priceCents,
      benefits: [
        "Logo on event signage",
        "Recognition from the podium",
        `${t.includedTickets} complimentary attendee ticket(s)`,
      ],
      inventory: t.inventory,
      soldCount: 0,
      includedTickets: t.includedTickets,
      sortOrder: i,
      isActive: true,
    }));
    tierInserts.push(...rows);
    return rows;
  }

  // ---- 5 historical conferences, each with its paired sponsorship event.
  const conferenceYears = [2021, 2022, 2023, 2024, 2025];
  for (const year of conferenceYears) {
    const venue = year % 2 === 0 ? VENUES[0] : VENUES[1];
    const start = new Date(Date.UTC(year, 9, 14, 16, 0, 0));
    const confId = uid();
    const sponId = uid();

    eventInserts.push({
      id: sponId,
      name: `${year} WACA Annual Conference - Sponsorship`,
      slug: `waca-annual-conference-${year}-sponsorship`,
      kind: "sponsorship",
      status: "completed",
      visibility: "members-only",
      summary: `Sponsorship packages for the ${year} WACA Annual Conference.`,
      description: "Paired sponsorship event. (Demo data.)",
      startsAt: start,
      endsAt: addDays(start, 2),
      venueName: venue.venueName,
      venueAddress: venue.venueAddress,
      city: venue.city,
      state: "WA",
      isVirtual: false,
      capacity: null,
      registrationOpensAt: addDays(start, -150),
      registrationClosesAt: addDays(start, -7),
      pairedSponsorshipEventId: null,
      councilId: null,
      registeredCount: 0,
      attendedCount: 0,
      contactEmail: `events@waca.${EMAIL_DOMAIN}`,
    });

    eventInserts.push({
      id: confId,
      name: `${year} WACA Annual Conference`,
      slug: `waca-annual-conference-${year}`,
      kind: "conference",
      status: "completed",
      visibility: "public",
      summary: `Two days of policy, compliance and market sessions at the ${venue.venueName}.`,
      description:
        "The flagship WACA gathering: policy briefings, regulator Q&A, market data, and the wine tour. (Demo data.)",
      startsAt: start,
      endsAt: addDays(start, 2),
      venueName: venue.venueName,
      venueAddress: venue.venueAddress,
      city: venue.city,
      state: "WA",
      isVirtual: false,
      capacity: 220,
      registrationOpensAt: addDays(start, -120),
      registrationClosesAt: addDays(start, -3),
      pairedSponsorshipEventId: sponId,
      councilId: null,
      registeredCount: 0,
      attendedCount: 0,
      contactEmail: `events@waca.${EMAIL_DOMAIN}`,
    });

    addTickets(confId, "conference");
    addTickets(sponId, "sponsorship");
    addTiers(sponId);

    ["Opening Keynote: The Session Ahead", "WSLCB Regulator Panel", "Market Data Deep Dive", "Wine Tour Departure"]
      .forEach((title, i) =>
        sessionInserts.push({
          id: uid(),
          eventId: confId,
          title,
          description: null,
          startsAt: new Date(start.getTime() + i * 3 * 3600000),
          endsAt: new Date(start.getTime() + (i * 3 + 2) * 3600000),
          room: pick(["Grand Ballroom", "Vineyard Room", "Salon A", "Terrace"]),
          speakers: [{ name: `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`, title: pick(TITLES) }],
          capacity: null,
          requiresSignup: title.includes("Wine"),
          sortOrder: i,
        }),
      );
  }

  // ---- 28 further historical events across the real kinds.
  const otherKinds: {
    kind: "day-on-the-hill" | "sector-council" | "member-meeting" | "fundraiser" | "webinar" | "workshop";
    count: number;
  }[] = [
    { kind: "day-on-the-hill", count: 5 },
    { kind: "sector-council", count: 8 },
    { kind: "member-meeting", count: 5 },
    { kind: "fundraiser", count: 4 },
    { kind: "webinar", count: 4 },
    { kind: "workshop", count: 2 },
  ];

  let histIndex = 0;
  for (const { kind, count } of otherKinds) {
    for (let i = 0; i < count; i++) {
      histIndex += 1;
      const daysAgo = 60 + histIndex * 41 + int(0, 20);
      const start = addDays(TODAY, -daysAgo);
      start.setUTCHours(17, 0, 0, 0);
      const id = uid();
      const isVirtual = kind === "webinar";
      const venue = isVirtual ? null : kind === "day-on-the-hill" ? VENUES[3] : pick(VENUES);
      const council =
        kind === "sector-council" ? councilRows[histIndex % councilRows.length] : null;

      // Legislator and congressional fundraisers are NEVER public.
      const isLegislatorFundraiser = kind === "fundraiser";
      const visibility = isLegislatorFundraiser
        ? i % 2 === 0
          ? ("invite-only" as const)
          : ("admin-only" as const)
        : kind === "webinar" || kind === "member-meeting" || kind === "sector-council"
          ? ("members-only" as const)
          : ("public" as const);

      const nameByKind: Record<string, string> = {
        "day-on-the-hill": `Day on the Hill ${start.getUTCFullYear()}`,
        "sector-council": `${council?.name ?? "Sector Council"} Meeting - ${start.toLocaleString("en-US", { month: "long", timeZone: "UTC" })} ${start.getUTCFullYear()}`,
        "member-meeting": `Quarterly Member Meeting - Q${Math.floor(start.getUTCMonth() / 3) + 1} ${start.getUTCFullYear()}`,
        fundraiser: `${i % 2 === 0 ? "Legislator" : "Congressional"} Reception - ${start.toLocaleString("en-US", { month: "long", timeZone: "UTC" })} ${start.getUTCFullYear()}`,
        webinar: `Compliance Webinar: ${pick(["Traceability", "Packaging Rules", "Tax Reporting", "Advertising Limits"])} (${start.getUTCFullYear()})`,
        workshop: `Member Workshop: ${pick(["Budgeting for Renewal", "Preparing for Audit"])} ${start.getUTCFullYear()}`,
      };
      const name = nameByKind[kind];

      eventInserts.push({
        id,
        name,
        slug: `${slugify(name)}-${histIndex}`,
        kind,
        status: "completed",
        visibility,
        summary: `${name}. (Demo data.)`,
        description: null,
        startsAt: start,
        endsAt: addDays(start, kind === "day-on-the-hill" ? 0 : 0),
        venueName: venue?.venueName ?? null,
        venueAddress: venue?.venueAddress ?? null,
        city: venue?.city ?? null,
        state: "WA",
        isVirtual,
        virtualUrl: isVirtual ? `https://meet.${EMAIL_DOMAIN}/waca-${histIndex}` : null,
        capacity: isVirtual ? null : int(40, 120),
        registrationOpensAt: addDays(start, -45),
        registrationClosesAt: addDays(start, -1),
        pairedSponsorshipEventId: null,
        councilId: council?.id ?? null,
        registeredCount: 0,
        attendedCount: 0,
        contactEmail: `events@waca.${EMAIL_DOMAIN}`,
      });
      addTickets(id, kind);
      if (kind === "day-on-the-hill") addTiers(id);
    }
  }

  // ---- 3 upcoming events with open registration.
  const upcoming: {
    name: string;
    kind: "conference" | "sector-council" | "webinar";
    days: number;
    visibility: "public" | "members-only";
    venue: (typeof VENUES)[number] | null;
  }[] = [
    { name: "2026 WACA Annual Conference", kind: "conference", days: 56, visibility: "public", venue: VENUES[0] },
    { name: "Retail Sector Council - September 2026", kind: "sector-council", days: 21, visibility: "members-only", venue: VENUES[2] },
    { name: "Compliance Webinar: 2027 Session Preview", kind: "webinar", days: 34, visibility: "members-only", venue: null },
  ];
  const upcomingIds: string[] = [];
  for (const u of upcoming) {
    const id = uid();
    upcomingIds.push(id);
    const start = addDays(TODAY, u.days);
    start.setUTCHours(16, 0, 0, 0);

    let pairedId: string | null = null;
    if (u.kind === "conference") {
      pairedId = uid();
      eventInserts.push({
        id: pairedId,
        name: `${u.name} - Sponsorship`,
        slug: `${slugify(u.name)}-sponsorship`,
        kind: "sponsorship",
        status: "published",
        visibility: "members-only",
        summary: `Sponsorship packages for the ${u.name}.`,
        startsAt: start,
        endsAt: addDays(start, 2),
        venueName: u.venue?.venueName ?? null,
        venueAddress: u.venue?.venueAddress ?? null,
        city: u.venue?.city ?? null,
        state: "WA",
        isVirtual: false,
        registrationOpensAt: addDays(TODAY, -30),
        registrationClosesAt: addDays(start, -7),
        pairedSponsorshipEventId: null,
        councilId: null,
        registeredCount: 0,
        attendedCount: 0,
        contactEmail: `events@waca.${EMAIL_DOMAIN}`,
      });
      addTickets(pairedId, "sponsorship");
      addTiers(pairedId);
    }

    eventInserts.push({
      id,
      name: u.name,
      slug: slugify(u.name),
      kind: u.kind,
      status: "published",
      visibility: u.visibility,
      summary: `${u.name}. Registration is open. (Demo data.)`,
      description: null,
      startsAt: start,
      endsAt: u.kind === "conference" ? addDays(start, 2) : start,
      venueName: u.venue?.venueName ?? null,
      venueAddress: u.venue?.venueAddress ?? null,
      city: u.venue?.city ?? null,
      state: "WA",
      isVirtual: u.kind === "webinar",
      virtualUrl: u.kind === "webinar" ? `https://meet.${EMAIL_DOMAIN}/waca-2027-preview` : null,
      capacity: u.kind === "conference" ? 240 : 120,
      registrationOpensAt: addDays(TODAY, -20),
      registrationClosesAt: addDays(start, -2),
      waitlistEnabled: u.kind === "conference",
      pairedSponsorshipEventId: pairedId,
      councilId: u.kind === "sector-council" ? councilBySlug.get("retail")!.id : null,
      registeredCount: 0,
      attendedCount: 0,
      contactEmail: `events@waca.${EMAIL_DOMAIN}`,
    });
    addTickets(id, u.kind);
  }

  // Insert sponsorship events first so paired FKs resolve.
  const ordered = [...eventInserts].sort((a, b) =>
    a.kind === "sponsorship" ? -1 : b.kind === "sponsorship" ? 1 : 0,
  );
  await db.insert(s.events).values(ordered);
  await db.insert(s.ticketTypes).values(ticketInserts);
  await db.insert(s.eventSessions).values(sessionInserts);
  await db.insert(s.sponsorTiers).values(tierInserts);

  /* ----------------------------------------------------- registrations */
  const ticketsByEvent = new Map<string, (typeof s.ticketTypes.$inferInsert)[]>();
  for (const t of ticketInserts) {
    const arr = ticketsByEvent.get(t.eventId as string) ?? [];
    arr.push(t);
    ticketsByEvent.set(t.eventId as string, arr);
  }

  const registrationInserts: (typeof s.registrations.$inferInsert)[] = [];
  const eventStats = new Map<string, { registered: number; attended: number }>();

  for (const ev of eventInserts) {
    if (ev.kind === "sponsorship") continue;
    const tickets = (ticketsByEvent.get(ev.id) ?? []).filter((t) => !t.isInternal);
    if (!tickets.length) continue;

    const isPast = (ev.startsAt as Date).getTime() < TODAY.getTime();
    const target = isPast ? int(7, 62) : int(9, 38);

    // Sample distinct contacts so the (event, contact, ticket) unique index
    // is never violated.
    const shuffled = [...contactSeeds];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const chosen = shuffled.slice(0, Math.min(target, shuffled.length));

    // Real benchmark: 60 registered / 47 attended = 78%. Seed 78-86%.
    const attendanceRate = 0.78 + rng() * 0.08;
    let registered = 0;
    let attended = 0;

    for (const contact of chosen) {
      const ticket = pick(tickets);
      const cancelled = chance(0.05);
      const waitlisted = !cancelled && ev.capacity != null && chance(0.03);
      const status = cancelled
        ? ("cancelled" as const)
        : waitlisted
          ? ("waitlisted" as const)
          : isPast
            ? ("confirmed" as const)
            : chance(0.8)
              ? ("confirmed" as const)
              : ("pending" as const);

      const checkedIn =
        isPast && status === "confirmed" && rng() < attendanceRate;
      if (status !== "cancelled") registered += 1;
      if (checkedIn) attended += 1;

      registrationInserts.push({
        id: uid(),
        eventId: ev.id,
        ticketTypeId: ticket.id as string,
        contactId: contact.id,
        organizationId: contact.orgId,
        status,
        attendeeName: contact.name,
        attendeeEmail: contact.email,
        attendeeTitle: pick(TITLES),
        attendeeOrganizationName: orgById.get(contact.orgId)!.displayName,
        guestFields: chance(0.18)
          ? { dietary_needs: pick(["Vegetarian", "Gluten free", "No shellfish"]) }
          : {},
        pricePaidCents: status === "cancelled" ? 0 : (ticket.priceCents as number),
        registeredAt: addDays(ev.startsAt as Date, -int(3, 40)),
        confirmedAt: status === "confirmed" ? addDays(ev.startsAt as Date, -int(1, 30)) : null,
        cancelledAt: status === "cancelled" ? addDays(ev.startsAt as Date, -int(1, 10)) : null,
        checkedInAt: checkedIn ? new Date((ev.startsAt as Date).getTime() + 1800000) : null,
        waitlistPosition: waitlisted ? int(1, 8) : null,
      });
    }
    eventStats.set(ev.id, { registered, attended });
  }
  await db.insert(s.registrations).values(registrationInserts);

  for (const [eventId, stat] of eventStats) {
    await db.execute(sql`
      UPDATE events SET registered_count = ${stat.registered},
                        attended_count  = ${stat.attended}
       WHERE id = ${eventId}::uuid
    `);
  }

  /* ------------------------------------------------------ sponsorships */
  const sponsorshipInserts: (typeof s.eventSponsorships.$inferInsert)[] = [];
  const tiersByEvent = new Map<string, (typeof s.sponsorTiers.$inferInsert)[]>();
  for (const t of tierInserts) {
    const arr = tiersByEvent.get(t.eventId as string) ?? [];
    arr.push(t);
    tiersByEvent.set(t.eventId as string, arr);
  }
  for (const [eventId, tiers] of tiersByEvent) {
    const ev = eventInserts.find((e) => e.id === eventId)!;
    const isPast = (ev.startsAt as Date).getTime() < TODAY.getTime();
    const howMany = int(4, 9);
    const usedTiers = new Set<string>();
    for (let i = 0; i < howMany; i++) {
      const tier = pick(tiers);
      if (usedTiers.has(tier.name as string) && (tier.inventory ?? 99) <= 1) continue;
      usedTiers.add(tier.name as string);
      const org = pick(orgSeeds);
      const primary = contactSeeds.find((c) => c.orgId === org.id && c.isPrimary);
      sponsorshipInserts.push({
        id: uid(),
        eventId,
        sponsorTierId: tier.id as string,
        organizationId: org.id,
        sponsorName: org.displayName,
        contactId: primary?.id ?? null,
        status: isPast ? "paid" : chance(0.6) ? "confirmed" : "proposed",
        amountCents: tier.priceCents as number,
        fulfilmentNotes: null,
        benefitsDelivered: isPast ? { logo: true, podium: true } : {},
        confirmedAt: isPast ? addDays(ev.startsAt as Date, -int(20, 90)) : null,
      });
    }
  }
  await db.insert(s.eventSponsorships).values(sponsorshipInserts);

  /* ---------------------------------------------------------- invoices */
  const invoiceInserts: (typeof s.invoices.$inferInsert)[] = [];
  const lineInserts: (typeof s.invoiceLines.$inferInsert)[] = [];
  const paymentInserts: (typeof s.payments.$inferInsert)[] = [];
  const allocationInserts: (typeof s.paymentAllocations.$inferInsert)[] = [];
  const refundInserts: (typeof s.refunds.$inferInsert)[] = [];

  let invoiceCounter = 0;
  const invoiceNumber = (d: Date) =>
    `WACA-${d.getUTCFullYear()}-${String(++invoiceCounter).padStart(4, "0")}`;

  /**
   * Records an invoice plus, when settled, the OFFLINE payment and its
   * allocation. Cheque / ACH / bank transfer only -- WACA does not take cards.
   */
  function addInvoice(opts: {
    organizationId: string;
    contactId: string | null;
    source: (typeof s.invoiceSourceEnum.enumValues)[number];
    description: string;
    amountCents: number;
    issued: Date;
    dueDays: number;
    settle: "paid" | "partial" | "unpaid" | "void";
    membershipId?: string | null;
    eventId?: string | null;
    registrationId?: string | null;
    eventSponsorshipId?: string | null;
    membershipLevelId?: string | null;
  }) {
    const id = uid();
    const due = addDays(opts.issued, opts.dueDays);
    const paid =
      opts.settle === "paid"
        ? opts.amountCents
        : opts.settle === "partial"
          ? Math.round(opts.amountCents * (0.3 + rng() * 0.4))
          : 0;

    const overdue =
      opts.settle !== "paid" &&
      opts.settle !== "void" &&
      due.getTime() < TODAY.getTime();

    // Partially-paid wins over overdue: staff want to see that money came in.
    const status =
      opts.settle === "void"
        ? ("void" as const)
        : opts.settle === "paid"
          ? ("paid" as const)
          : opts.settle === "partial"
            ? ("partially-paid" as const)
            : overdue
              ? ("overdue" as const)
              : ("sent" as const);

    invoiceInserts.push({
      id,
      number: invoiceNumber(opts.issued),
      organizationId: opts.organizationId,
      contactId: opts.contactId,
      source: opts.source,
      status,
      membershipId: opts.membershipId ?? null,
      eventId: opts.eventId ?? null,
      registrationId: opts.registrationId ?? null,
      eventSponsorshipId: opts.eventSponsorshipId ?? null,
      subtotalCents: opts.amountCents,
      taxCents: 0,
      discountCents: 0,
      totalCents: opts.amountCents,
      amountPaidCents: paid,
      amountRefundedCents: 0,
      issuedOn: iso(opts.issued),
      dueOn: iso(due),
      sentAt: opts.issued,
      paidAt: opts.settle === "paid" ? addDays(opts.issued, int(3, 25)) : null,
      voidedAt: opts.settle === "void" ? addDays(opts.issued, int(1, 10)) : null,
      voidReason: opts.settle === "void" ? "Issued in error (demo data)" : null,
      billToSnapshot: {},
      paymentTerms:
        "Payable by cheque or ACH. Cheques payable to Washington CannaBusiness Association. WACA does not accept card payments.",
      memo: null,
    });

    lineInserts.push({
      id: uid(),
      invoiceId: id,
      description: opts.description,
      quantity: 1,
      unitPriceCents: opts.amountCents,
      amountCents: opts.amountCents,
      discountCents: 0,
      taxCents: 0,
      glCode: opts.source.startsWith("membership") ? "4000-DUES" : "4100-EVENTS",
      membershipLevelId: opts.membershipLevelId ?? null,
      sortOrder: 0,
    });

    if (paid > 0) {
      const paymentId = uid();
      const receivedOn = addDays(opts.issued, int(3, 25));
      paymentInserts.push({
        id: paymentId,
        organizationId: opts.organizationId,
        contactId: opts.contactId,
        method: pick(["cheque", "ach", "bank-transfer"] as const),
        amountCents: paid,
        receivedOn: iso(receivedOn),
        depositedOn: iso(addDays(receivedOn, int(1, 4))),
        reference: `CHK-${int(10000, 99999)}`,
        bankAccountLabel: "Operating",
        unappliedCents: 0,
        notes: null,
      });
      allocationInserts.push({
        id: uid(),
        paymentId,
        invoiceId: id,
        amountCents: paid,
        allocatedOn: iso(receivedOn),
      });
    }
    return { id, paid, status };
  }

  // Membership dues invoices, one per bundle for the current term.
  for (const m of membershipInserts) {
    const org = orgById.get(m.organizationId as string)!;
    const primary = contactSeeds.find((c) => c.orgId === org.id && c.isPrimary);
    const level = levelRows.find((l) => l.id === m.levelId)!;
    const status = m.status as string;
    const issued = addDays(new Date(m.termStartsOn as string), -21);

    const settle: "paid" | "partial" | "unpaid" =
      status === "active"
        ? "paid"
        : status === "renewal-overdue"
          ? "unpaid"
          : status === "pending-renewal"
            ? chance(0.5)
              ? "partial"
              : "unpaid"
            : "unpaid";

    addInvoice({
      organizationId: org.id,
      contactId: primary?.id ?? null,
      source: status === "pending-new" ? "membership-new" : "membership-renewal",
      description: `${level.name} - annual dues, term beginning ${m.termStartsOn}`,
      amountCents: level.feeCents,
      issued,
      dueDays: 30,
      settle,
      membershipId: m.id as string,
      membershipLevelId: level.id,
    });
  }

  // Event registration invoices for paid tickets.
  const paidRegistrations = registrationInserts.filter(
    (r) => (r.pricePaidCents as number) > 0 && r.status !== "cancelled",
  );
  for (const r of paidRegistrations) {
    if (!chance(0.55)) continue; // not every registration is separately invoiced
    const ev = eventInserts.find((e) => e.id === r.eventId)!;
    const isPast = (ev.startsAt as Date).getTime() < TODAY.getTime();
    addInvoice({
      organizationId: r.organizationId as string,
      contactId: r.contactId as string,
      source: "event-registration",
      description: `${ev.name} - registration for ${r.attendeeName}`,
      amountCents: r.pricePaidCents as number,
      issued: r.registeredAt as Date,
      dueDays: 21,
      settle: isPast ? "paid" : chance(0.6) ? "paid" : "unpaid",
      eventId: ev.id,
      registrationId: r.id as string,
    });
  }

  // Sponsorship invoices.
  for (const sp of sponsorshipInserts) {
    if (sp.status === "proposed") continue;
    const ev = eventInserts.find((e) => e.id === sp.eventId)!;
    addInvoice({
      organizationId: sp.organizationId as string,
      contactId: sp.contactId as string | null,
      source: "sponsorship",
      description: `${ev.name} - sponsorship`,
      amountCents: sp.amountCents as number,
      issued: addDays(ev.startsAt as Date, -int(30, 100)),
      dueDays: 30,
      settle: sp.status === "paid" ? "paid" : "unpaid",
      eventId: ev.id,
      eventSponsorshipId: sp.id as string,
    });
  }

  // A handful of draft and voided invoices so every status in the enum is
  // represented in the demo account.
  for (let i = 0; i < 3; i++) {
    const org = pick(orgSeeds);
    const primary = contactSeeds.find((c) => c.orgId === org.id && c.isPrimary);
    const issued = addDays(TODAY, -int(1, 12));
    invoiceInserts.push({
      id: uid(),
      number: invoiceNumber(issued),
      organizationId: org.id,
      contactId: primary?.id ?? null,
      source: "other",
      status: "draft",
      subtotalCents: 25_000,
      taxCents: 0,
      discountCents: 0,
      totalCents: 25_000,
      amountPaidCents: 0,
      amountRefundedCents: 0,
      issuedOn: null,
      dueOn: null,
      billToSnapshot: {},
      paymentTerms:
        "Payable by cheque or ACH. WACA does not accept card payments.",
      memo: "Draft - not yet sent. (Demo data.)",
    });
    lineInserts.push({
      id: uid(),
      invoiceId: invoiceInserts[invoiceInserts.length - 1].id as string,
      description: "Miscellaneous member service (draft)",
      quantity: 1,
      unitPriceCents: 25_000,
      amountCents: 25_000,
      sortOrder: 0,
    });
  }
  for (let i = 0; i < 2; i++) {
    const org = pick(orgSeeds);
    const issued = addDays(TODAY, -int(30, 200));
    invoiceInserts.push({
      id: uid(),
      number: invoiceNumber(issued),
      organizationId: org.id,
      contactId: null,
      source: "other",
      status: "void",
      subtotalCents: 52_500,
      taxCents: 0,
      discountCents: 0,
      totalCents: 52_500,
      amountPaidCents: 0,
      amountRefundedCents: 0,
      issuedOn: iso(issued),
      dueOn: iso(addDays(issued, 30)),
      sentAt: issued,
      voidedAt: addDays(issued, 4),
      voidReason: "Issued to the wrong bundle (demo data)",
      billToSnapshot: {},
      memo: null,
    });
    lineInserts.push({
      id: uid(),
      invoiceId: invoiceInserts[invoiceInserts.length - 1].id as string,
      description: "Voided dues line",
      quantity: 1,
      unitPriceCents: 52_500,
      amountCents: 52_500,
      sortOrder: 0,
    });
  }

  await db.insert(s.invoices).values(invoiceInserts);
  await db.insert(s.invoiceLines).values(lineInserts);
  await db.insert(s.payments).values(paymentInserts);
  await db.insert(s.paymentAllocations).values(allocationInserts);

  // A couple of unapplied payments for the allocation screen.
  for (let i = 0; i < 3; i++) {
    const org = pick(orgSeeds);
    const amount = pick([52_500, 210_000, 315_000]);
    await db.insert(s.payments).values({
      id: uid(),
      organizationId: org.id,
      contactId: contactSeeds.find((c) => c.orgId === org.id)?.id ?? null,
      method: "cheque",
      amountCents: amount,
      receivedOn: iso(addDays(TODAY, -int(2, 30))),
      reference: `CHK-${int(10000, 99999)}`,
      bankAccountLabel: "Operating",
      unappliedCents: amount,
      notes: "Received without a remittance advice - needs allocation.",
    });
  }

  // Two recorded refunds (offline: a cheque cut back to the member).
  const refundable = invoiceInserts.filter((i) => i.status === "paid").slice(0, 2);
  for (const inv of refundable) {
    const amount = Math.round((inv.totalCents as number) * 0.5);
    refundInserts.push({
      id: uid(),
      invoiceId: inv.id as string,
      paymentId: null,
      organizationId: inv.organizationId as string,
      amountCents: amount,
      method: "cheque",
      refundedOn: iso(addDays(TODAY, -int(5, 60))),
      reference: `CHK-${int(10000, 99999)}`,
      reason: "Duplicate registration (demo data)",
    });
    await db.execute(sql`
      UPDATE invoices SET amount_refunded_cents = ${amount}
       WHERE id = ${inv.id as string}::uuid
    `);
  }
  await db.insert(s.refunds).values(refundInserts);

  /* --------------------------------------------------------- documents */
  const documentInserts: (typeof s.documents.$inferInsert)[] = [];
  const conferenceEvents = eventInserts.filter((e) => e.kind === "conference");

  // 16 weekly Detail Reports -- the bill-tracking files members cannot
  // currently reach in Wild Apricot.
  for (let w = 0; w < 16; w++) {
    const d = addDays(TODAY, -7 * w - 3);
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const yy = String(d.getUTCFullYear()).slice(2);
    const title = `${mm}.${dd}.${yy} WACA Detail Report w/ Upcoming`;
    documentInserts.push({
      id: uid(),
      title,
      slug: slugify(title),
      description:
        "Weekly legislative bill tracking with upcoming hearings and committee action.",
      category: "detail-report",
      accessScope: "members",
      levelRestrictions: [],
      councilRestrictions: [],
      fileKey: `documents/detail-reports/${slugify(title)}.pdf`,
      fileName: `${title}.pdf`,
      mime: "application/pdf",
      bytes: int(180_000, 2_400_000),
      pages: int(8, 44),
      publishedOn: iso(d),
      policyYear: d.getUTCFullYear(),
      relatedBills: [`HB ${int(1000, 2200)}`, `SB ${int(5000, 6200)}`],
      tags: ["legislative", "weekly", "bill-tracking"],
      isOcrNeeded: false,
    });
  }

  const otherDocs: {
    title: string;
    category: (typeof s.documentCategoryEnum.enumValues)[number];
    scope: (typeof s.documentAccessScopeEnum.enumValues)[number];
    ocr?: boolean;
  }[] = [
    { title: "2027 WACA Legislative Agenda", category: "legislative-agenda", scope: "members" },
    { title: "2026 WACA Legislative Agenda", category: "legislative-agenda", scope: "public" },
    { title: "Testimony - HB 1341 Retail Licensing", category: "testimony", scope: "public" },
    { title: "Testimony - SB 5069 Testing Standards", category: "testimony", scope: "members" },
    { title: "Comment Letter - WSLCB Packaging Rulemaking", category: "comment-letter", scope: "members" },
    { title: "Comment Letter - Local Zoning Preemption", category: "comment-letter", scope: "members" },
    { title: "Press Release - WACA Statement on Session Close", category: "press-release", scope: "public" },
    { title: "Press Release - New Board Announced", category: "press-release", scope: "public" },
    { title: "Position Paper - Excise Tax Reform", category: "position-paper", scope: "level-restricted" },
    { title: "Position Paper - Social Equity Licensing", category: "position-paper", scope: "members" },
    { title: "2025 Washington Cannabis Market Report", category: "report", scope: "level-restricted" },
    { title: "Retail Council Packet - Spring 2026", category: "report", scope: "council-restricted" },
    { title: "Lab Council Packet - Spring 2026", category: "report", scope: "council-restricted" },
    { title: "Producers Council Packet - Spring 2026", category: "report", scope: "council-restricted" },
    { title: "Archived Scan - 2019 Board Minutes", category: "report", scope: "members", ocr: true },
  ];

  for (const d of otherDocs) {
    const published = addDays(TODAY, -int(20, 700));
    documentInserts.push({
      id: uid(),
      title: d.title,
      slug: slugify(d.title),
      description: `${d.title}. (Demo data.)`,
      category: d.category,
      accessScope: d.scope,
      levelRestrictions:
        d.scope === "level-restricted"
          ? [levelBySlug.get("full-1")!.id, levelBySlug.get("full-2")!.id]
          : [],
      councilRestrictions:
        d.scope === "council-restricted"
          ? [
              d.title.startsWith("Retail")
                ? councilBySlug.get("retail")!.id
                : d.title.startsWith("Lab")
                  ? councilBySlug.get("lab")!.id
                  : councilBySlug.get("producers")!.id,
            ]
          : [],
      councilId:
        d.scope === "council-restricted"
          ? d.title.startsWith("Retail")
            ? councilBySlug.get("retail")!.id
            : d.title.startsWith("Lab")
              ? councilBySlug.get("lab")!.id
              : councilBySlug.get("producers")!.id
          : null,
      fileKey: `documents/${d.category}/${slugify(d.title)}.pdf`,
      fileName: `${d.title}.pdf`,
      mime: "application/pdf",
      bytes: int(120_000, 6_500_000),
      pages: int(2, 60),
      publishedOn: iso(published),
      policyYear: published.getUTCFullYear(),
      relatedBills: [],
      tags: [d.category],
      isOcrNeeded: Boolean(d.ocr),
      downloadCount: int(0, 140),
    });
  }

  // Event materials attached to the historical conferences.
  for (const ev of conferenceEvents.slice(0, 4)) {
    const title = `${ev.name} - Slide Deck`;
    documentInserts.push({
      id: uid(),
      title,
      slug: slugify(title),
      description: "Conference slide deck. (Demo data.)",
      category: "event-material",
      accessScope: "members",
      levelRestrictions: [],
      councilRestrictions: [],
      fileKey: `documents/event-material/${slugify(title)}.pdf`,
      fileName: `${title}.pdf`,
      mime: "application/pdf",
      bytes: int(2_000_000, 24_000_000),
      pages: int(20, 90),
      publishedOn: iso(addDays(ev.startsAt as Date, 3)),
      policyYear: (ev.startsAt as Date).getUTCFullYear(),
      relatedBills: [],
      tags: ["conference"],
      isOcrNeeded: false,
      eventId: ev.id,
    });
  }

  await db.insert(s.documents).values(documentInserts);

  // Download trail, so the "most read" report has something in it.
  const downloadInserts: (typeof s.documentDownloads.$inferInsert)[] = [];
  for (const doc of documentInserts) {
    const n = int(0, 6);
    for (let i = 0; i < n; i++) {
      const c = pick(contactSeeds);
      downloadInserts.push({
        id: uid(),
        documentId: doc.id as string,
        contactId: c.id,
        userId: null,
        ipAddress: `198.51.100.${int(2, 250)}`,
        userAgent: "Mozilla/5.0 (demo seed)",
        at: addDays(TODAY, -int(1, 180)),
      });
    }
  }
  if (downloadInserts.length)
    await db.insert(s.documentDownloads).values(downloadInserts);

  /* ------------------------------------------------------------- users */
  function hash(pw: string) {
    const salt = randomBytes(16).toString("hex");
    return `scrypt$${salt}$${scryptSync(pw, salt, 64).toString("hex")}`;
  }
  const DEMO_PASSWORD = "waca-demo-password";

  const adminContactId = uid();
  const staffContactId = uid();
  await db.insert(s.contacts).values([
    {
      id: adminContactId,
      firstName: "Dana",
      lastName: "Whitfield",
      displayName: "Dana Whitfield",
      email: `admin@waca.${EMAIL_DOMAIN}`,
      title: "Executive Director",
      organizationId: null,
      isBundleAdmin: false,
      isPrimaryContact: false,
      contactFieldValues: {},
      tags: ["waca-staff"],
    },
    {
      id: staffContactId,
      firstName: "Rowan",
      lastName: "Petrakis",
      displayName: "Rowan Petrakis",
      email: `staff@waca.${EMAIL_DOMAIN}`,
      title: "Membership Coordinator",
      organizationId: null,
      isBundleAdmin: false,
      isPrimaryContact: false,
      contactFieldValues: {},
      tags: ["waca-staff"],
    },
  ]);

  const demoBundleAdmin = contactSeeds.find((c) => c.isBundleAdmin)!;
  const demoMember = contactSeeds.find((c) => !c.isBundleAdmin)!;

  const userRows = [
    { id: uid(), name: "Dana Whitfield", email: `admin@waca.${EMAIL_DOMAIN}`, role: "admin" as const, contactId: adminContactId },
    { id: uid(), name: "Rowan Petrakis", email: `staff@waca.${EMAIL_DOMAIN}`, role: "staff" as const, contactId: staffContactId },
    { id: uid(), name: demoBundleAdmin.name, email: demoBundleAdmin.email, role: "bundle_admin" as const, contactId: demoBundleAdmin.id },
    { id: uid(), name: demoMember.name, email: demoMember.email, role: "member" as const, contactId: demoMember.id },
  ].map((u) => ({
    ...u,
    emailVerified: TODAY,
    passwordHash: hash(DEMO_PASSWORD),
    isActive: true,
  }));
  await db.insert(s.users).values(userRows);

  for (const u of userRows) {
    await db.execute(sql`
      UPDATE contacts SET user_id = ${u.id}::uuid WHERE id = ${u.contactId}::uuid
    `);
  }

  /* --------------------------------------------------------- audit log */
  await db.insert(s.auditLog).values(
    userRows.slice(0, 2).flatMap((u) =>
      ["login", "create", "payment-record"].map((action) => ({
        id: uid(),
        actorUserId: u.id,
        actorContactId: u.contactId,
        actorLabel: u.name,
        action: action as (typeof s.auditActionEnum.enumValues)[number],
        entity: action === "payment-record" ? "payments" : "users",
        entityId: null,
        diff: {},
        metadata: { source: "seed", demo: true },
        at: addDays(TODAY, -int(1, 30)),
      })),
    ),
  );

  /* ---------------------------------------------- renewal reminder log */
  const reminderLogInserts: (typeof s.renewalReminders.$inferInsert)[] = [];
  for (const m of membershipInserts) {
    const sent = (m.renewalRemindersSent as number) ?? 0;
    for (let i = 0; i < sent && i < reminderRules.length; i++) {
      const rule = reminderRules[i];
      reminderLogInserts.push({
        id: uid(),
        membershipId: m.id as string,
        ruleId: rule.id,
        contactId:
          contactSeeds.find((c) => c.orgId === m.organizationId && c.isPrimary)?.id ?? null,
        dueForExpiresOn: m.expiresOn as string,
        scheduledFor: addDays(new Date(m.expiresOn as string), -rule.offsetDays),
        sentAt: addDays(new Date(m.expiresOn as string), -rule.offsetDays),
        status: "sent",
        channel: "email",
        providerMessageId: `demo-${uid().slice(0, 8)}`,
      });
    }
  }
  if (reminderLogInserts.length)
    await db.insert(s.renewalReminders).values(reminderLogInserts);

  /* ----------------------------------------------------------- summary */
  const tables = [
    "users","accounts","sessions","verification_tokens",
    "organizations","contacts","contact_fields",
    "membership_levels","memberships","membership_applications",
    "renewal_reminder_rules","renewal_reminders",
    "councils","council_members","council_priorities",
    "events","event_sessions","ticket_types","sponsor_tiers",
    "registrations","event_sponsorships",
    "invoices","invoice_lines","payments","payment_allocations","refunds",
    "documents","document_downloads","audit_log",
  ];

  console.log("\nSeed complete.  IS_DEMO_DATA = true\n");
  console.log("table                        rows");
  console.log("---------------------------------");
  let grand = 0;
  for (const t of tables) {
    const r = await client.unsafe(`select count(*)::int as c from ${t}`);
    const c = Number(r[0].c);
    grand += c;
    console.log(`${t.padEnd(28)} ${String(c).padStart(4)}`);
  }
  console.log("---------------------------------");
  console.log(`${"TOTAL".padEnd(28)} ${String(grand).padStart(4)}\n`);

  const breakdown = await client.unsafe(`
    select ml.name, m.status, count(*)::int as c
      from memberships m join membership_levels ml on ml.id = m.level_id
     where m.is_current group by 1,2 order by 1,2
  `);
  console.log("membership level x status");
  for (const row of breakdown) {
    console.log(`  ${String(row.name).padEnd(34)} ${String(row.status).padEnd(22)} ${row.c}`);
  }

  console.log(`\nDemo logins (password: ${DEMO_PASSWORD})`);
  for (const u of userRows) console.log(`  ${u.role.padEnd(13)} ${u.email}`);

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
