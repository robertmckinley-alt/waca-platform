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
import { createHash, scryptSync, randomBytes } from "node:crypto";

import * as s from "./schema";
import { slugify as sharedSlugify } from "@/lib/slug";
import { renderCampaign } from "@/lib/email/campaign/render";

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

/** THE slugifier. The seed does not get its own. */
const slugify = (v: string) => sharedSlugify(v);

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
      email_events, campaign_recipients, campaigns,
      unsubscribe_tokens, suppressions,
      email_templates, audience_members, audiences,
      content_publishes, content_assets,
      content_revision_sequences, content_revisions, content_items,
      content_types,
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


  /* ==================================================================== *
   *  CONTENT  --  the CMS mirror of the public site.
   *
   *  Page titles and slugs mirror waca-web's real information architecture,
   *  because that is what the CMS has to be able to edit. Everything with a
   *  byline, a quote or a person's name in it is INVENTED, exactly like the
   *  rest of this file: no real press headline, outlet, trustee or member of
   *  staff appears here.
   * ==================================================================== */

  const adminUser = userRows[0];
  const staffUser = userRows[1];

  const typeSeeds: {
    key: (typeof s.contentTypeKeyEnum.enumValues)[number];
    label: string;
    labelPlural: string;
    description: string;
    routePattern: string | null;
    astroTarget: string | null;
    isSingleton?: boolean;
    allowsCreate?: boolean;
    fields: s.ContentFieldDef[];
  }[] = [
    {
      key: "page",
      label: "Page",
      labelPlural: "Pages",
      description: "A standing page in the site's navigation.",
      routePattern: "/:slug",
      astroTarget: "src/pages",
      fields: [
        { name: "path", label: "URL path", type: "text", required: true, sidebar: true, help: "e.g. /about/leadership" },
        { name: "lede", label: "Lede", type: "textarea", required: true },
        { name: "body", label: "Body", type: "markdown", required: true },
        { name: "heroImage", label: "Hero image", type: "image", altTextRequired: true },
        { name: "metaDescription", label: "Meta description", type: "textarea", sidebar: true, max: 160 },
      ],
    },
    {
      key: "press",
      label: "Press item",
      labelPlural: "Press coverage",
      description: "Coverage of WACA, and WACA's own releases and statements.",
      routePattern: "/media/press/:slug",
      astroTarget: "press",
      fields: [
        { name: "headline", label: "Headline", type: "text", required: true },
        { name: "date", label: "Date", type: "date", required: true, sidebar: true },
        { name: "outlet", label: "Outlet", type: "text" },
        { name: "url", label: "Link to coverage", type: "url" },
        { name: "kind", label: "Kind", type: "select", required: true, sidebar: true, options: [
          { value: "article", label: "Article" },
          { value: "broadcast", label: "Broadcast" },
          { value: "op-ed", label: "Op-ed" },
          { value: "release", label: "Release" },
          { value: "statement", label: "Statement" },
        ] },
        { name: "topics", label: "Topics", type: "multiselect", options: [
          { value: "banking", label: "Banking" },
          { value: "federal", label: "Federal" },
          { value: "hemp-thc", label: "Hemp and THC" },
          { value: "labor", label: "Labor" },
          { value: "licensing", label: "Licensing" },
          { value: "public-health", label: "Public health" },
          { value: "rulemaking", label: "Rulemaking" },
          { value: "social-equity", label: "Social equity" },
          { value: "taxation", label: "Taxation" },
          { value: "testimony", label: "Testimony" },
          { value: "youth-access", label: "Youth access" },
        ] },
        { name: "featured", label: "Featured", type: "boolean", sidebar: true },
      ],
    },
    {
      key: "record",
      label: "Advocacy record",
      labelPlural: "Advocacy record",
      description: "Testimony, comment letters, coalition letters, reports.",
      routePattern: "/policy/record/:slug",
      astroTarget: "records",
      fields: [
        { name: "title", label: "Title", type: "text", required: true },
        { name: "date", label: "Date", type: "date", required: true, sidebar: true },
        { name: "type", label: "Type", type: "select", required: true, sidebar: true, options: [
          { value: "comment-letter", label: "Comment letter" },
          { value: "coalition-letter", label: "Coalition letter" },
          { value: "position", label: "Position" },
          { value: "report", label: "Report" },
          { value: "testimony", label: "Testimony" },
        ] },
        { name: "document", label: "Document", type: "asset" },
        { name: "billNumber", label: "Bill number", type: "text", sidebar: true },
        { name: "session", label: "Legislative session", type: "text", sidebar: true },
        { name: "body", label: "Summary", type: "markdown" },
      ],
    },
    {
      key: "agenda",
      label: "Agenda",
      labelPlural: "Legislative agendas",
      description: "The annual legislative and regulatory agenda.",
      routePattern: "/policy/agenda-archive/:slug",
      astroTarget: "agendas",
      fields: [
        { name: "year", label: "Year", type: "number", required: true, sidebar: true },
        { name: "title", label: "Title", type: "text", required: true },
        { name: "documents", label: "Documents", type: "array", fields: [
          { name: "label", label: "Label", type: "text", required: true },
          { name: "source", label: "File", type: "asset", required: true },
        ] },
        { name: "body", label: "Body", type: "markdown" },
      ],
    },
    {
      key: "post",
      label: "Post",
      labelPlural: "Blog",
      description: "Association news and member updates.",
      routePattern: "/media/blog/:slug",
      astroTarget: "posts",
      fields: [
        { name: "title", label: "Title", type: "text", required: true },
        { name: "date", label: "Date", type: "date", required: true, sidebar: true },
        { name: "author", label: "Author", type: "text", sidebar: true },
        { name: "body", label: "Body", type: "markdown", required: true },
        { name: "image", label: "Image", type: "image", altTextRequired: true },
      ],
    },
    {
      key: "person",
      label: "Person",
      labelPlural: "Board and staff",
      description: "Trustees and staff shown on the leadership page.",
      routePattern: "/about/leadership#:slug",
      astroTarget: "people",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "role", label: "Role", type: "text", required: true },
        { name: "org", label: "Organisation", type: "text" },
        { name: "group", label: "Group", type: "select", required: true, sidebar: true, options: [
          { value: "board", label: "Board" },
          { value: "staff", label: "Staff" },
        ] },
        { name: "boardOffice", label: "Board office", type: "select", sidebar: true, options: [
          { value: "president", label: "President" },
          { value: "vice-president", label: "Vice president" },
          { value: "treasurer", label: "Treasurer" },
          { value: "secretary", label: "Secretary" },
          { value: "trustee", label: "Trustee" },
        ] },
        { name: "headshot", label: "Headshot", type: "image", altTextRequired: true },
        { name: "bio", label: "Biography", type: "markdown" },
      ],
    },
    {
      key: "member",
      label: "Member listing",
      labelPlural: "Member directory",
      description:
        "Public directory entry. Derived from the membership tables by the directory sync; editors may amend the blurb but not create a listing.",
      routePattern: "/members#:slug",
      astroTarget: "members",
      allowsCreate: false,
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "category", label: "Category", type: "select", required: true, sidebar: true, options: [
          { value: "retailer", label: "Retailer" },
          { value: "producer-processor", label: "Producer / processor" },
          { value: "lab-transport", label: "Lab / transport" },
          { value: "ancillary", label: "Ancillary" },
        ] },
        { name: "url", label: "Website", type: "url" },
        { name: "logo", label: "Logo", type: "image", altTextRequired: true },
        { name: "consentPublicListing", label: "Consents to a public listing", type: "boolean", required: true, sidebar: true },
      ],
    },
    {
      key: "stat",
      label: "Statistic",
      labelPlural: "Statistics",
      description:
        "A figure the site is allowed to publish, with its source. No figure renders without one.",
      routePattern: null,
      astroTarget: "src/data/stats.yaml",
      fields: [
        { name: "value", label: "Value", type: "text", required: true },
        { name: "label", label: "Label", type: "text", required: true },
        { name: "sourceId", label: "Source id", type: "text", required: true, sidebar: true },
        { name: "sourceTitle", label: "Source title", type: "text", required: true },
        { name: "sourceUrl", label: "Source URL", type: "url" },
        { name: "asOf", label: "As of", type: "date", sidebar: true },
      ],
    },
    {
      key: "nav",
      label: "Navigation",
      labelPlural: "Navigation",
      description: "The primary and footer navigation trees.",
      routePattern: null,
      astroTarget: "src/data/nav.yaml",
      isSingleton: true,
      allowsCreate: false,
      fields: [
        { name: "primary", label: "Primary navigation", type: "array", fields: [
          { name: "label", label: "Label", type: "text", required: true },
          { name: "href", label: "Href", type: "text", required: true },
        ] },
        { name: "footer", label: "Footer navigation", type: "array", fields: [
          { name: "label", label: "Label", type: "text", required: true },
          { name: "href", label: "Href", type: "text", required: true },
        ] },
      ],
    },
    {
      key: "setting",
      label: "Setting",
      labelPlural: "Site settings",
      description: "Site-wide identity and contact facts.",
      routePattern: null,
      astroTarget: "src/data/site.yaml",
      allowsCreate: false,
      fields: [
        { name: "value", label: "Value", type: "text", required: true },
        { name: "note", label: "Note", type: "textarea" },
      ],
    },
  ];

  const contentTypeRows = typeSeeds.map((t, i) => ({
    id: uid(),
    key: t.key,
    label: t.label,
    labelPlural: t.labelPlural,
    description: t.description,
    fields: t.fields,
    routePattern: t.routePattern,
    astroTarget: t.astroTarget,
    isSingleton: t.isSingleton ?? false,
    allowsCreate: t.allowsCreate ?? true,
    sortOrder: i,
  }));
  await db.insert(s.contentTypes).values(contentTypeRows);

  /* ------------------------------------------------------ content items */

  type ContentStatus = (typeof s.contentStatusEnum.enumValues)[number];
  type ItemSeed = {
    type: (typeof s.contentTypeKeyEnum.enumValues)[number];
    slug: string;
    title: string;
    status: ContentStatus;
    data: Record<string, unknown>;
    excerpt?: string;
    sortOrder?: number;
    publishAt?: Date | null;
    /** How many revisions to write before the current one. */
    priorRevisions?: number;
  };

  const itemSeeds: ItemSeed[] = [];

  // --- pages: the site's real IA. Slug is flat (the CHECK forbids "/"),
  //     the URL path travels in data.path.
  const PAGES: [string, string, string, string][] = [
    ["home", "/", "Washington CannaBusiness Association", "The trade association for Washington's licensed cannabis businesses."],
    ["about", "/about", "Who We Are", "WACA represents licensed cannabis businesses before the Legislature and the Liquor and Cannabis Board."],
    ["about-leadership", "/about/leadership", "Board and Staff", "The trustees and staff who run the association."],
    ["about-democratic-process", "/about/democratic-process", "How WACA Decides", "Sector councils propose, the board disposes, the membership ratifies."],
    ["about-sector-councils", "/about/sector-councils", "Sector Councils", "Four councils, one per licence type, each with a seat at the policy table."],
    ["about-documents", "/about/documents", "Governing Documents", "Bylaws, code of conduct, and the refund policy."],
    ["policy", "/policy", "Policy", "What WACA is working on this session."],
    ["policy-agenda", "/policy/agenda", "Legislative and Regulatory Agenda", "The agenda the membership ratified for the coming session."],
    ["policy-agenda-archive", "/policy/agenda-archive", "Agenda Archive, 2015 to Today", "Every agenda WACA has adopted since incorporation."],
    ["policy-record", "/policy/record", "Advocacy Record", "Testimony, comment letters and coalition letters, in full."],
    ["policy-social-equity", "/policy/social-equity", "Social Equity", "WACA's position on the social equity programme."],
    ["members", "/members", "Members", "The organisations that make up the association."],
    ["membership", "/membership", "Membership", "Levels, fees, and how to join."],
    ["events", "/events", "Events", "Meetings, conferences and Day on the Hill."],
    ["contact", "/contact", "Contact", "How to reach the association."],
    ["ai-disclosure", "/ai-disclosure", "AI Disclosure", "Where machine assistance was used on this site, and where it was not."],
  ];
  PAGES.forEach(([slug, path, title, lede], i) => {
    itemSeeds.push({
      type: "page",
      slug,
      title,
      status: "published",
      sortOrder: i,
      excerpt: lede,
      priorRevisions: int(1, 4),
      data: {
        path,
        lede,
        body: `## ${title}\n\n${lede}\n\nThis body is synthetic seed copy standing in for the page WACA staff will edit here.`,
        metaDescription: lede.slice(0, 155),
      },
    });
  });
  // Two pages in flight, so the editor has something that is not live.
  itemSeeds.push({
    type: "page",
    slug: "about-annual-report",
    title: "Annual Report",
    status: "draft",
    sortOrder: 20,
    excerpt: "Draft: the 2026 annual report landing page.",
    priorRevisions: 2,
    data: { path: "/about/annual-report", lede: "Draft.", body: "Not finished." },
  });
  itemSeeds.push({
    type: "page",
    slug: "policy-2027-session-preview",
    title: "2027 Session Preview",
    status: "in_review",
    sortOrder: 21,
    excerpt: "Awaiting a read from the policy committee before it goes live.",
    priorRevisions: 3,
    data: {
      path: "/policy/2027-session-preview",
      lede: "What the 2027 session is likely to bring.",
      body: "Draft for committee review.",
    },
  });

  // --- press
  const PRESS_TOPICS = ["banking", "federal", "hemp-thc", "labor", "licensing", "public-health", "rulemaking", "social-equity", "taxation", "testimony", "youth-access"];
  const PRESS_OUTLETS = ["Cascade Business Journal", "Puget Sound Wire", "Evergreen Policy Review", "Olympia Dispatch", "Northwest Trade Weekly"];
  const PRESS_HEADLINES = [
    "Trade group backs excise tax restructuring ahead of session",
    "Licensed operators press regulators on testing standards",
    "Association testifies on transport rule rewrite",
    "Statement on the interim hemp-derived THC policy",
    "Retailers seek clarity on signage limits",
    "Producers welcome canopy reporting simplification",
    "Association comments on the social equity applicant window",
    "Board elects new officers for the coming term",
    "Labs raise accreditation timeline with the board",
    "Statement on the youth-access enforcement report",
    "Members brief lawmakers at Day on the Hill",
    "Association responds to the banking access proposal",
  ];
  PRESS_HEADLINES.forEach((headline, i) => {
    const daysAgo = 20 + i * 26 + int(0, 12);
    const status: ContentStatus =
      i === 0 ? "scheduled" : i === 1 ? "in_review" : "published";
    itemSeeds.push({
      type: "press",
      slug: slugify(headline).slice(0, 70),
      title: headline,
      status,
      sortOrder: i,
      excerpt: `${headline}.`,
      priorRevisions: int(0, 2),
      publishAt: status === "scheduled" ? addDays(TODAY, int(3, 20)) : null,
      data: {
        headline,
        date: iso(addDays(TODAY, -daysAgo)),
        outlet: pick(PRESS_OUTLETS),
        url: `https://example.org/coverage/${slugify(headline).slice(0, 40)}`,
        kind: pick(["article", "op-ed", "release", "statement"]),
        topics: [pick(PRESS_TOPICS), pick(PRESS_TOPICS)],
        featured: i < 3,
      },
    });
  });

  // --- advocacy record
  const RECORDS: [string, string, string][] = [
    ["Comment letter on transport manifest rulemaking", "comment-letter", "WAC 314-55"],
    ["Testimony on the excise tax restructuring bill", "testimony", "HB 1042"],
    ["Coalition letter on hemp-derived THC", "coalition-letter", "SB 5367"],
    ["Position on laboratory accreditation authority", "position", "SB 5376"],
    ["Comment letter on retail signage limits", "comment-letter", "WAC 314-55-155"],
    ["Report: the licensed market five years on", "report", ""],
    ["Testimony on licensee safety and robbery response", "testimony", "HB 1749"],
  ];
  RECORDS.forEach(([title, type, bill], i) => {
    itemSeeds.push({
      type: "record",
      slug: slugify(title).slice(0, 70),
      title,
      status: i === RECORDS.length - 1 ? "draft" : "published",
      sortOrder: i,
      excerpt: title,
      priorRevisions: int(0, 3),
      data: {
        title,
        date: iso(addDays(TODAY, -(40 + i * 70))),
        type,
        billNumber: bill || undefined,
        session: bill ? `${TODAY.getUTCFullYear() - (i % 3)} Regular Session` : undefined,
        body: `Synthetic summary of ${title.toLowerCase()}.`,
      },
    });
  });

  // --- agendas
  for (let y = 2023; y <= 2026; y++) {
    itemSeeds.push({
      type: "agenda",
      slug: String(y),
      title: `${y} Legislative and Regulatory Agenda`,
      status: "published",
      sortOrder: 2100 - y,
      excerpt: `The agenda the membership ratified for the ${y} session.`,
      priorRevisions: int(1, 3),
      data: {
        year: y,
        title: `${y} Legislative and Regulatory Agenda`,
        documents: [{ label: `${y} agenda (PDF)`, source: `docs/agenda-${y}.pdf` }],
        body: `Priorities adopted for the ${y} session.`,
      },
    });
  }
  itemSeeds.push({
    type: "agenda",
    slug: "2027",
    title: "2027 Legislative and Regulatory Agenda",
    status: "scheduled",
    sortOrder: 73,
    excerpt: "Ratified by the membership; goes live the morning of the policy meeting.",
    priorRevisions: 2,
    publishAt: addDays(TODAY, 34),
    data: { year: 2027, title: "2027 Legislative and Regulatory Agenda", documents: [], body: "Embargoed." },
  });

  // --- posts
  const POSTS = [
    "Welcome to the rebuilt member portal",
    "What the interim rules mean for producers",
    "Sector council recommendations are open for comment",
    "Registration is open for the spring meeting",
    "A short guide to reading the Detail Report",
    "How the annual agenda gets written",
  ];
  POSTS.forEach((title, i) => {
    itemSeeds.push({
      type: "post",
      slug: slugify(title).slice(0, 70),
      title,
      status: i === POSTS.length - 1 ? "draft" : "published",
      sortOrder: i,
      excerpt: title,
      priorRevisions: int(0, 2),
      data: {
        title,
        date: iso(addDays(TODAY, -(15 + i * 45))),
        author: i % 2 === 0 ? adminUser.name : staffUser.name,
        body: `Synthetic post body for "${title}".`,
      },
    });
  });

  // --- people (invented, like every other person in this file)
  const PEOPLE: [string, string, string, "board" | "staff", string | null][] = [
    ["Dana Whitfield", "Executive Director", "WACA", "staff", null],
    ["Rowan Petrakis", "Membership Manager", "WACA", "staff", null],
    ["Imani Castellanos", "Policy Director", "WACA", "staff", null],
    ["Teodora Lindqvist", "President", "Fernbrook Retail", "board", "president"],
    ["Marcus Ballenger", "Vice President", "Harrow Creek Growers", "board", "vice-president"],
    ["Priya Ravensworth", "Treasurer", "Northlight Labs", "board", "treasurer"],
    ["Silas Okonkwo", "Secretary", "Cedar Row Transport", "board", "secretary"],
    ["Nadia Brightwater", "Retail Representative", "Alder Street Cannabis", "board", "trustee"],
    ["Emeka Solheim", "Producer Representative", "Quarry Bend Farms", "board", "trustee"],
    ["Rosalind Achebe", "Ancillary Representative", "Kestrel Compliance", "board", "trustee"],
  ];
  PEOPLE.forEach(([name, role, org, group, office], i) => {
    itemSeeds.push({
      type: "person",
      slug: slugify(name),
      title: name,
      status: "published",
      sortOrder: i,
      excerpt: `${role}, ${org}`,
      priorRevisions: int(0, 2),
      data: {
        name,
        role,
        org,
        group,
        boardOffice: office ?? undefined,
        bio: `${name} is a synthetic seed record standing in for a real trustee or member of staff.`,
      },
    });
  });

  // --- member directory listings, derived from the organisations above
  orgInserts
    .filter((o) => o.publicListingConsent)
    .forEach((o, i) => {
      itemSeeds.push({
        type: "member",
        slug: o.slug as string,
        title: o.displayName as string,
        status: "published",
        sortOrder: i,
        excerpt: `${o.displayName} — ${o.category}`,
        priorRevisions: 0,
        data: {
          name: o.displayName,
          category: o.category,
          url: o.website ?? undefined,
          consentPublicListing: true,
        },
      });
    });

  // --- stats. Every figure carries its source, or it does not render.
  const STATS: [string, string, string, string][] = [
    ["54", "member organisations", "waca-membership-2026", "WACA membership records, August 2026"],
    ["2014", "founded", "waca-bylaws", "WACA bylaws, article I"],
    ["4", "sector councils", "waca-council-charter", "Sector council charter, 2023"],
    ["12", "annual agendas published", "waca-agenda-archive", "WACA agenda archive"],
    ["78", "documents in the advocacy record", "waca-record-index", "WACA advocacy record index"],
    ["253", "press entries since 2014", "waca-press-index", "WACA press index"],
  ];
  STATS.forEach(([value, label, sourceId, sourceTitle], i) => {
    itemSeeds.push({
      type: "stat",
      slug: slugify(label),
      title: `${value} ${label}`,
      status: "published",
      sortOrder: i,
      excerpt: sourceTitle,
      priorRevisions: 0,
      data: { value, label, sourceId, sourceTitle, asOf: iso(TODAY) },
    });
  });

  // --- nav (singleton) and settings
  itemSeeds.push({
    type: "nav",
    slug: "primary",
    title: "Site navigation",
    status: "published",
    sortOrder: 0,
    excerpt: "Six primary items, deliberately.",
    priorRevisions: 2,
    data: {
      primary: [
        { label: "About", href: "/about" },
        { label: "Policy", href: "/policy" },
        { label: "Members", href: "/members" },
        { label: "Media", href: "/media" },
        { label: "Events", href: "/events" },
        { label: "Membership", href: "/membership" },
      ],
      footer: [
        { label: "Contact", href: "/contact" },
        { label: "Governing documents", href: "/about/documents" },
        { label: "AI disclosure", href: "/ai-disclosure" },
      ],
    },
  });
  const SETTINGS: [string, string, string][] = [
    ["site-name", "Washington CannaBusiness Association", "Rendered in the masthead and the document title."],
    ["short-name", "WACA", "Used where the full name does not fit."],
    ["general-email", `info@waca.${EMAIL_DOMAIN}`, "Synthetic address. The real one arrives with the importer."],
    ["media-email", `media@waca.${EMAIL_DOMAIN}`, "Synthetic address."],
    ["member-portal-url", "https://members.example.org", "Synthetic. Points at the portal in production."],
  ];
  SETTINGS.forEach(([slug, value, note], i) => {
    itemSeeds.push({
      type: "setting",
      slug,
      title: slug.replace(/-/g, " "),
      status: "published",
      sortOrder: i,
      excerpt: value,
      priorRevisions: 0,
      data: { value, note },
    });
  });

  /**
   * An EARLIER version of an item's payload.
   *
   * Revision N of a seeded item used to be a byte-for-byte copy of revision 1,
   * which made the history screen technically correct and completely useless:
   * every comparison read "identical in every field". A revision history where
   * nothing ever changed cannot demonstrate a diff, and cannot be reviewed.
   *
   * `stepsBack` is how far back this revision is from the current one. The
   * newest revision is ALWAYS the untouched payload, so what is live still
   * matches content_items.data exactly.
   */
  const LONG_TEXT_KEYS = ["body", "bio", "lede", "description"];
  function earlierDraftOf(
    data: Record<string, unknown>,
    stepsBack: number,
  ): Record<string, unknown> {
    if (stepsBack <= 0) return data;
    const copy: Record<string, unknown> = { ...data };

    // Prefer shortening the prose: an earlier draft with fewer sentences is
    // what an edit history actually looks like.
    for (const key of LONG_TEXT_KEYS) {
      const value = copy[key];
      if (typeof value === "string" && value.length > 60) {
        const parts = value.split(". ").filter(Boolean);
        if (parts.length > 1) {
          const keep = Math.max(1, parts.length - stepsBack);
          const kept = parts.slice(0, keep).join(". ");
          copy[key] = kept.endsWith(".") ? kept : `${kept}.`;
          return copy;
        }
        // One long sentence: an earlier draft got as far as most of it.
        const words = value.split(" ");
        const keep = Math.max(6, words.length - stepsBack * 4);
        copy[key] = `${words.slice(0, keep).join(" ").replace(/[.,]$/, "")}.`;
        return copy;
      }
    }

    // No prose to shorten: an earlier draft had not filled in the last
    // optional fields yet.
    const keys = Object.keys(copy);
    for (let i = 0; i < stepsBack && keys.length - i > 3; i += 1) {
      delete copy[keys[keys.length - 1 - i]];
    }
    return copy;
  }

  /* Write items, then their revisions, then point the published ones at the
   * revision that is live -- the same three steps saveDraft() + publishItems()
   * take, so the seed cannot produce a state the application could not. */
  const itemRows: (typeof s.contentItems.$inferInsert & { id: string })[] = [];
  const revisionRows: (typeof s.contentRevisions.$inferInsert & { id: string })[] = [];
  const revisionSeqRows: (typeof s.contentRevisionSequences.$inferInsert)[] = [];
  const liveRevisionByItem = new Map<string, string>();

  for (const seed of itemSeeds) {
    const id = uid();
    const createdAt = addDays(TODAY, -int(30, 700));
    itemRows.push({
      id,
      type: seed.type,
      slug: seed.slug,
      title: seed.title,
      // Inserted as a draft even when it will end up published: CHECK
      // content_items_published_needs_revision refuses a published row with no
      // live revision, and the revision does not exist yet. The UPDATE below
      // sets status and published_revision_id together, which is exactly what
      // publishItems() does.
      status: seed.status === "published" ? "draft" : seed.status,
      data: seed.data,
      locale: "en-US",
      sortOrder: seed.sortOrder ?? 0,
      excerpt: seed.excerpt ?? null,
      publishAt: seed.publishAt ?? null,
      unpublishAt: null,
      publishedRevisionId: null,
      publishedAt: seed.status === "published" ? addDays(createdAt, int(0, 20)) : null,
      createdBy: adminUser.id,
      updatedBy: chance(0.5) ? adminUser.id : staffUser.id,
      createdAt,
      updatedAt: addDays(createdAt, int(0, 40)),
    });

    const total = (seed.priorRevisions ?? 0) + 1;
    let last = "";
    for (let n = 1; n <= total; n++) {
      const rid = uid();
      last = rid;
      revisionRows.push({
        id: rid,
        itemId: id,
        revisionNumber: n,
        data: earlierDraftOf(seed.data, total - n),
        title: seed.title,
        slug: seed.slug,
        excerpt: seed.excerpt ?? null,
        summary:
          n === 1
            ? "Created."
            : n === total
              ? pick(["Copy edit.", "Updated the lede.", "Fixed a link.", "Board feedback."])
              : pick(["Draft revision.", "Restructured.", "Added a quote."]),
        authorUserId: chance(0.6) ? adminUser.id : staffUser.id,
        authorLabel: chance(0.6) ? adminUser.name : staffUser.name,
        restoredFromRevisionId: null,
        createdAt: addDays(createdAt, n),
      });
    }
    revisionSeqRows.push({ itemId: id, lastNumber: total });
    if (seed.status === "published") liveRevisionByItem.set(id, last);
  }

  await db.insert(s.contentItems).values(itemRows);
  await db.insert(s.contentRevisions).values(revisionRows);
  await db.insert(s.contentRevisionSequences).values(revisionSeqRows);
  for (const [itemId, revisionId] of liveRevisionByItem) {
    await db.execute(sql`
      UPDATE content_items
         SET status = 'published', published_revision_id = ${revisionId}::uuid
       WHERE id = ${itemId}::uuid
    `);
  }

  /* ---------------------------------------------------- content assets */
  const ASSETS: [string, string, string | null, number, number, string | null, boolean][] = [
    ["hero-capitol-steps.jpg", "image/jpeg", "Members on the Capitol steps in Olympia at Day on the Hill.", 2400, 1350, "WACA staff photo", false],
    ["hero-greenhouse.jpg", "image/jpeg", "Rows of plants under lights in a licensed production facility.", 2400, 1350, "WACA staff photo", false],
    ["board-meeting.jpg", "image/jpeg", "Trustees around a table at the autumn board meeting.", 1600, 1067, "WACA staff photo", false],
    ["spring-meeting-panel.jpg", "image/jpeg", "Four panellists on stage at the spring meeting.", 1600, 1067, "WACA staff photo", false],
    ["testimony-hearing-room.jpg", "image/jpeg", "A witness table in a legislative hearing room.", 1600, 1067, null, false],
    ["sector-council-retail.jpg", "image/jpeg", "Retail sector council members in discussion.", 1600, 1067, null, false],
    ["divider-leaf-pattern.svg", "image/svg+xml", null, 1200, 80, null, false],
    ["market-size-chart.png", "image/png", "Bar chart of licensed market revenue by year, 2016 to 2025.", 1200, 800, "Chart by WACA", false],
    ["agenda-cover-2026.png", "image/png", "Cover of the 2026 legislative agenda.", 1000, 1294, null, false],
    ["logo-waca-mark.svg", "image/svg+xml", "WACA logo.", 400, 400, null, false],
    ["illustrative-skyline.png", "image/png", "Stylised Olympia skyline at dusk.", 1600, 600, "Generated illustration", true],
    ["2026-agenda.pdf", "application/pdf", null, 0, 0, null, false],
  ];
  const assetRows = ASSETS.map(([filename, mime, alt, w, h, credit, ai], i) => ({
    id: uid(),
    key: `content/2026/${filename}`,
    filename,
    mime,
    bytes: int(40_000, 3_500_000),
    width: mime.startsWith("image/") ? w : null,
    height: mime.startsWith("image/") ? h : null,
    // The divider is the one genuinely decorative image; everything else
    // carries alt text, and the CHECK in 0006 will not let it be otherwise.
    altText: alt,
    isDecorative: mime.startsWith("image/") && alt === null,
    credit,
    aiGenerated: ai,
    aiNote: ai ? "Generated illustration; disclosed on /ai-disclosure." : null,
    longDescription:
      filename === "market-size-chart.png"
        ? "Licensed market revenue rises from 2016 to a 2021 peak, then flattens through 2025."
        : null,
    uploadedBy: i % 2 === 0 ? adminUser.id : staffUser.id,
    createdAt: addDays(TODAY, -int(20, 500)),
  }));
  await db.insert(s.contentAssets).values(assetRows);

  /* Point some content at the library.
   *
   * A media library nothing references is a folder. These UPDATEs give the
   * page and post collections real asset fields, which is what makes the
   * picker, the alt-text gate and the `assets` map on /api/content/* visible
   * in the demo rather than theoretical.
   *
   * Both the item AND its live revision are patched. Patching only the item
   * would leave the working copy and the published revision disagreeing —
   * which is precisely the state the two-column design exists to prevent, and
   * a seed must never produce a state the application could not.
   */
  const HERO_KEYS = [
    "content/2026/hero-capitol-steps.jpg",
    "content/2026/hero-greenhouse.jpg",
  ];
  const POST_IMAGE_KEYS = [
    "content/2026/board-meeting.jpg",
    "content/2026/spring-meeting-panel.jpg",
    "content/2026/sector-council-retail.jpg",
  ];

  for (const [type, field, keys] of [
    ["page", "heroImage", HERO_KEYS],
    ["post", "image", POST_IMAGE_KEYS],
  ] as const) {
    const targets = itemRows.filter((r) => r.type === type).slice(0, keys.length);
    for (const [i, row] of targets.entries()) {
      const key = keys[i];
      await db.execute(sql`
        UPDATE content_items
           SET data = jsonb_set(data, ${`{${field}}`}::text[], to_jsonb(${key}::text), true)
         WHERE id = ${row.id}::uuid
      `);
      await db.execute(sql`
        UPDATE content_revisions
           SET data = jsonb_set(data, ${`{${field}}`}::text[], to_jsonb(${key}::text), true)
         WHERE item_id = ${row.id}::uuid
           AND revision_number = (
             SELECT max(revision_number) FROM content_revisions
              WHERE item_id = ${row.id}::uuid)
      `);
    }
  }

  /* -------------------------------------------------- publish history */
  const publishedItemIds = [...liveRevisionByItem.keys()];
  const publishRows = Array.from({ length: 6 }, (_, i) => {
    const started = addDays(TODAY, -(4 + i * 23));
    const batch = publishedItemIds.slice(i * 5, i * 5 + int(2, 7));
    const failed = i === 4;
    return {
      id: uid(),
      status: (failed ? "failed" : "succeeded") as (typeof s.contentPublishStatusEnum.enumValues)[number],
      itemIds: batch,
      itemCount: batch.length,
      triggeredBy: i % 2 === 0 ? adminUser.id : staffUser.id,
      triggeredByLabel: i % 2 === 0 ? adminUser.name : staffUser.name,
      note: pick([
        "Press round-up.",
        "Agenda page correction.",
        "Leadership page update.",
        "Weekly publish.",
      ]),
      deployHookStatus: failed ? 500 : 201,
      deployHookResponse: failed
        ? { error: "deploy hook returned 500" }
        : { job: { id: `demo-${uid().slice(0, 8)}`, state: "PENDING" } },
      deploymentId: failed ? null : `dpl_${uid().slice(0, 12)}`,
      deploymentUrl: failed ? null : `https://waca-web-${uid().slice(0, 7)}.vercel.app`,
      error: failed ? "Vercel deploy hook returned 500; retried by hand." : null,
      startedAt: started,
      completedAt: addDays(started, 0),
    };
  });
  await db.insert(s.contentPublishes).values(publishRows);

  /* ==================================================================== *
   *  EMAIL
   * ==================================================================== */

  const levelId = (slug: string) => levelBySlug.get(slug)!.id;
  const councilId = (slug: string) => councilBySlug.get(slug)!.id;

  type AudienceSeed = {
    name: string;
    description: string;
    isDynamic: boolean;
    rules: s.AudienceRule;
  };
  const audienceSeeds: AudienceSeed[] = [
    {
      name: "All members",
      description: "Every contact at an organisation holding a current membership, in any status.",
      isDynamic: true,
      rules: { all: [{ field: "has_membership", op: "is", value: true }] },
    },
    {
      name: "Full members",
      description: "Contacts at organisations on any Full membership level.",
      isDynamic: true,
      rules: {
        all: [
          { field: "membership_level", op: "in", values: ["full-1", "full-2", "full-3", "full-4"].map(levelId) },
        ],
      },
    },
    {
      name: "Level 1 only",
      description: "Full Membership Level 1 — the top fee band, and where most of the dues income sits.",
      isDynamic: true,
      rules: { all: [{ field: "membership_level", op: "in", values: [levelId("full-1")] }] },
    },
    {
      name: "Retail council",
      description: "Everyone actively sitting on the retail sector council.",
      isDynamic: true,
      rules: { all: [{ field: "sector_council", op: "in", values: [councilId("retail")] }] },
    },
    {
      name: "Producers council",
      description: "Everyone actively sitting on the producer sector council.",
      isDynamic: true,
      rules: { all: [{ field: "sector_council", op: "in", values: [councilId("producers")] }] },
    },
    {
      name: "Labs and transporters",
      description: "Contacts at lab and transport organisations, whether or not they sit on the council.",
      isDynamic: true,
      rules: {
        all: [{ field: "organization_category", op: "in", values: ["lab-transport"] }],
      },
    },
    {
      name: "Ancillary",
      description: "Contacts at ancillary businesses — the service providers around the licensed market.",
      isDynamic: true,
      rules: { all: [{ field: "organization_category", op: "in", values: ["ancillary"] }] },
    },
    {
      name: "Lapsed and overdue",
      description:
        "Renewal is overdue or the membership has lapsed. The list the renewal push goes to; note it deliberately does NOT test the subscribed flag, because a renewal notice is transactional.",
      isDynamic: true,
      rules: {
        all: [
          { field: "membership_status", op: "in", values: ["renewal-overdue", "lapsed", "pending-renewal"] },
        ],
      },
    },
    {
      name: "Non-member contacts",
      description:
        "Agency staff, legislative offices, journalists and prospects. No current membership anywhere, and opted in.",
      isDynamic: true,
      rules: {
        all: [
          { field: "has_membership", op: "is", value: false },
          { field: "subscribed", op: "is", value: true },
        ],
      },
    },
    {
      name: "2026 Day on the Hill attendees (snapshot)",
      description:
        "Frozen list of confirmed attendees, taken the morning after the event so a follow-up can be re-sent to exactly the people who got the original.",
      isDynamic: false,
      rules: {
        all: [
          {
            field: "event_attendance",
            op: "attended",
            values: eventInserts
              .filter((e) => e.kind === "day-on-the-hill")
              .slice(0, 2)
              .map((e) => e.id),
          },
        ],
      },
    },
  ];

  const audienceRows = audienceSeeds.map((a) => ({
    id: uid(),
    name: a.name,
    description: a.description,
    rules: a.rules,
    isDynamic: a.isDynamic,
    snapshotTakenAt: a.isDynamic ? null : addDays(TODAY, -170),
    lastResolvedCount: null as number | null,
    lastResolvedAt: addDays(TODAY, -int(1, 20)),
    createdBy: adminUser.id,
    createdAt: addDays(TODAY, -int(200, 500)),
  }));
  await db.insert(s.audiences).values(audienceRows);
  const audienceByName = new Map(audienceRows.map((a) => [a.name, a]));

  const mailableContacts = contactSeeds.filter((c) => !!c.email);

  /* --------------------------------------------------------- templates */
  const templateRows = [
    {
      id: uid(),
      name: "Member newsletter",
      description: "The fortnightly round-up: policy, events, member news.",
      subject: "WACA This Fortnight",
      preheader: "Policy movement, upcoming meetings, and what your council is working on.",
      category: "newsletter" as const,
      blocks: [
        { type: "heading", level: 1, text: "WACA This Fortnight" },
        { type: "paragraph", html: "<p>The short version of what moved.</p>" },
        { type: "dynamic", source: "upcoming-events", limit: 3 },
        { type: "divider" },
        { type: "dynamic", source: "recent-press", limit: 4 },
      ] as s.EmailBlock[],
      textBody:
        "WACA THIS FORTNIGHT\n\nThe short version of what moved.\n\nUpcoming events follow, then recent coverage.\n\nUnsubscribe: {{unsubscribe_url}}",
    },
    {
      id: uid(),
      name: "Policy alert",
      description: "Short, urgent, one ask. Used when a bill moves.",
      subject: "Policy alert: {{bill}}",
      preheader: "One ask, and the deadline.",
      category: "policy-alert" as const,
      blocks: [
        { type: "heading", level: 1, text: "Policy alert" },
        { type: "paragraph", html: "<p>What moved, and what we are asking members to do.</p>" },
        { type: "button", label: "Read the position", href: "https://example.org/" },
      ] as s.EmailBlock[],
      textBody:
        "POLICY ALERT\n\nWhat moved, and what we are asking members to do.\n\nRead the position: https://example.org/\n\nUnsubscribe: {{unsubscribe_url}}",
    },
    {
      id: uid(),
      name: "Event invitation",
      description: "Meetings, the spring meeting, Day on the Hill.",
      subject: "You're invited: {{event}}",
      preheader: "Date, place, and how to register.",
      category: "event" as const,
      blocks: [
        { type: "heading", level: 1, text: "{{event}}" },
        { type: "paragraph", html: "<p>Date, venue and agenda.</p>" },
        { type: "button", label: "Register", href: "https://example.org/" },
      ] as s.EmailBlock[],
      textBody:
        "{{event}}\n\nDate, venue and agenda.\n\nRegister: https://example.org/\n\nUnsubscribe: {{unsubscribe_url}}",
    },
    {
      id: uid(),
      name: "Renewal reminder",
      description: "Membership renewal. Transactional in tone, and never sent to a suppressed address.",
      subject: "Your WACA membership renews on {{date}}",
      preheader: "What is due, and how to settle it.",
      category: "membership" as const,
      blocks: [
        { type: "heading", level: 1, text: "Your membership renewal" },
        { type: "paragraph", html: "<p>WACA settles offline — cheque, ACH or bank transfer. There is no card payment.</p>" },
      ] as s.EmailBlock[],
      textBody:
        "YOUR MEMBERSHIP RENEWAL\n\nWACA settles offline - cheque, ACH or bank transfer. There is no card payment.\n\nUnsubscribe: {{unsubscribe_url}}",
    },
  ].map((t) => ({
    ...t,
    // Rendered from the template's own blocks by the same renderer the
    // composer uses, so a template's plain-text part is a real rendering
    // rather than a second, hand-maintained copy that can drift.
    textBody: renderCampaign({
      subject: t.subject,
      preheader: t.preheader,
      blocks: t.blocks,
    }).text,
    createdBy: adminUser.id,
    createdAt: addDays(TODAY, -int(300, 600)),
  }));
  await db.insert(s.emailTemplates).values(templateRows);

  /* --------------------------------------------------------- campaigns */
  const CAMPAIGN_PLAN: {
    name: string;
    subject: string;
    audience: string;
    template: number;
    category: (typeof s.emailCategoryEnum.enumValues)[number];
    daysAgo: number;
    status: (typeof s.campaignStatusEnum.enumValues)[number];
  }[] = [
    { name: "February newsletter", subject: "WACA This Fortnight — February", audience: "All members", template: 0, category: "newsletter", daysAgo: 190, status: "sent" },
    { name: "Day on the Hill invitation", subject: "You're invited: 2026 Day on the Hill", audience: "All members", template: 2, category: "event", daysAgo: 178, status: "sent" },
    { name: "Excise tax alert", subject: "Policy alert: excise tax restructuring", audience: "Full members", template: 1, category: "policy-alert", daysAgo: 160, status: "sent" },
    { name: "Retail signage consultation", subject: "Retail council: signage limits consultation", audience: "Retail council", template: 1, category: "policy-alert", daysAgo: 141, status: "sent" },
    { name: "Canopy reporting update", subject: "Producers: canopy reporting is changing", audience: "Producers council", template: 1, category: "policy-alert", daysAgo: 122, status: "sent" },
    { name: "April newsletter", subject: "WACA This Fortnight — April", audience: "All members", template: 0, category: "newsletter", daysAgo: 104, status: "sent" },
    { name: "Lab accreditation briefing", subject: "Labs and transporters: accreditation timeline", audience: "Labs and transporters", template: 1, category: "policy-alert", daysAgo: 86, status: "sent" },
    { name: "Spring meeting invitation", subject: "You're invited: 2026 Spring Meeting", audience: "All members", template: 2, category: "event", daysAgo: 63, status: "sent" },
    { name: "Renewal push — overdue", subject: "Your WACA membership renewal is overdue", audience: "Lapsed and overdue", template: 3, category: "membership", daysAgo: 41, status: "sent" },
    { name: "Ancillary member survey", subject: "Two minutes: what should WACA do for ancillary members?", audience: "Ancillary", template: 0, category: "newsletter", daysAgo: 22, status: "sent" },
    { name: "August newsletter", subject: "WACA This Fortnight — August", audience: "All members", template: 0, category: "newsletter", daysAgo: 3, status: "sent" },
    { name: "2027 agenda announcement", subject: "The 2027 agenda is ratified", audience: "All members", template: 0, category: "newsletter", daysAgo: -34, status: "scheduled" },
    { name: "Non-member policy digest", subject: "WACA policy digest", audience: "Non-member contacts", template: 1, category: "policy-alert", daysAgo: 0, status: "draft" },
  ];

  /** Which contacts each named audience covers, in seed terms.
   *  orgById / membershipByOrg are the maps built above; reused, not rebuilt. */
  const councilContactIds = new Map<string, Set<string>>();
  for (const cm of councilMemberInserts) {
    const set = councilContactIds.get(cm.councilId as string) ?? new Set<string>();
    set.add(cm.contactId as string);
    councilContactIds.set(cm.councilId as string, set);
  }

  function audienceContacts(name: string): typeof contactSeeds {
    switch (name) {
      case "All members":
        return mailableContacts.filter((c) => membershipByOrg.has(c.orgId));
      case "Full members":
        return mailableContacts.filter((c) => {
          const m = membershipByOrg.get(c.orgId);
          return !!m && ["full-1", "full-2", "full-3", "full-4"].map(levelId).includes(m.levelId as string);
        });
      case "Level 1 only":
        return mailableContacts.filter(
          (c) => membershipByOrg.get(c.orgId)?.levelId === levelId("full-1"),
        );
      case "Retail council":
        return mailableContacts.filter((c) =>
          councilContactIds.get(councilId("retail"))?.has(c.id),
        );
      case "Producers council":
        return mailableContacts.filter((c) =>
          councilContactIds.get(councilId("producers"))?.has(c.id),
        );
      case "Labs and transporters":
        return mailableContacts.filter(
          (c) => orgById.get(c.orgId)?.category === "lab-transport",
        );
      case "Ancillary":
        return mailableContacts.filter(
          (c) => orgById.get(c.orgId)?.category === "ancillary",
        );
      case "Lapsed and overdue":
        return mailableContacts.filter((c) =>
          ["renewal-overdue", "pending-renewal"].includes(
            (membershipByOrg.get(c.orgId)?.status as string) ?? "",
          ),
        );
      case "Non-member contacts":
        return mailableContacts.filter((c) => !membershipByOrg.has(c.orgId)).slice(0, 30);
      case "2026 Day on the Hill attendees (snapshot)": {
        const dothIds = new Set(
          eventInserts.filter((e) => e.kind === "day-on-the-hill").slice(0, 2).map((e) => e.id),
        );
        const attended = new Set(
          registrationInserts
            .filter((r) => dothIds.has(r.eventId as string) && r.status === "confirmed")
            .map((r) => r.contactId as string),
        );
        return mailableContacts.filter((c) => attended.has(c.id));
      }
      default:
        return mailableContacts;
    }
  }

  const campaignRows: (typeof s.campaigns.$inferInsert & { id: string })[] = [];
  const recipientRows: (typeof s.campaignRecipients.$inferInsert & { id: string })[] = [];
  const suppressionRows: (typeof s.suppressions.$inferInsert)[] = [];
  const unsubTokenRows: (typeof s.unsubscribeTokens.$inferInsert)[] = [];
  const suppressed = new Set<string>();

  /** Deterministic sha256, so the seed stays byte-identical run to run. */
  const sha256 = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");

  // A handful of addresses that were already suppressed before any of these
  // campaigns ran — hard bounces and two complaints. These are what the
  // campaign_recipients trigger exists to keep out.
  for (let i = 0; i < 9; i++) {
    const c = mailableContacts[int(0, mailableContacts.length - 1)];
    const email = c.email.toLowerCase();
    if (suppressed.has(email)) continue;
    suppressed.add(email);
    suppressionRows.push({
      id: uid(),
      email,
      reason: i < 6 ? "bounced" : "complained",
      source: "resend-webhook",
      campaignId: null,
      contactId: c.id,
      detail: i < 6 ? "550 5.1.1 mailbox unavailable" : "Marked as spam by the recipient.",
      createdAt: addDays(TODAY, -int(200, 400)),
    });
  }

  for (const plan of CAMPAIGN_PLAN) {
    const id = uid();
    const audience = audienceByName.get(plan.audience)!;
    const template = templateRows[plan.template];
    const sentAt = plan.status === "sent" ? addDays(TODAY, -plan.daysAgo) : null;
    const people = audienceContacts(plan.audience).filter(
      (c) => !suppressed.has(c.email.toLowerCase()),
    );

    let deliveredCount = 0;
    let uniqueOpenCount = 0;
    let uniqueClickCount = 0;
    let bounceCount = 0;
    let complaintCount = 0;
    let unsubscribeCount = 0;

    if (plan.status === "sent") {
      for (const person of people) {
        const roll = rng();
        let status: (typeof s.campaignRecipientStatusEnum.enumValues)[number];
        // WACA's real newsletters run about 60% opens. Model that: ~2.5%
        // bounce, and of what is delivered, ~17% click, ~44% open without
        // clicking -> ~61% unique opens of delivered.
        if (roll < 0.025) status = "bounced";
        else if (roll < 0.029) status = "complained";
        else if (roll < 0.038) status = "unsubscribed";
        else if (roll < 0.205) status = "clicked";
        else if (roll < 0.63) status = "opened";
        else status = "delivered";

        const rid = uid();
        const sent = addDays(sentAt!, 0);
        const opened =
          status === "opened" || status === "clicked" || status === "unsubscribed"
            ? new Date(sent.getTime() + int(4, 2600) * 60000)
            : null;

        if (status === "bounced") bounceCount++;
        else deliveredCount++;
        if (status === "complained") complaintCount++;
        if (status === "unsubscribed") unsubscribeCount++;
        if (status === "opened" || status === "clicked" || status === "unsubscribed")
          uniqueOpenCount++;
        if (status === "clicked") uniqueClickCount++;

        recipientRows.push({
          id: rid,
          campaignId: id,
          contactId: person.id,
          email: person.email.toLowerCase(),
          status,
          providerMessageId: `demo-${rid.slice(0, 18)}`,
          sentAt: sent,
          deliveredAt: status === "bounced" ? null : new Date(sent.getTime() + int(1, 400) * 1000),
          firstOpenedAt: opened,
          lastOpenedAt: opened ? new Date(opened.getTime() + int(0, 5000) * 60000) : null,
          firstClickedAt:
            status === "clicked" && opened
              ? new Date(opened.getTime() + int(1, 240) * 60000)
              : null,
          openCount: opened ? int(1, 6) : 0,
          clickCount: status === "clicked" ? int(1, 4) : 0,
          error: status === "bounced" ? "550 5.1.1 mailbox unavailable" : null,
          createdAt: sent,
        });

        // An unsubscribe or a hard bounce lands on the global list, exactly as
        // redeem_unsubscribe_token() and the webhook reducer would put it there.
        const email = person.email.toLowerCase();
        if ((status === "unsubscribed" || status === "bounced" || status === "complained") && !suppressed.has(email)) {
          suppressed.add(email);
          suppressionRows.push({
            id: uid(),
            email,
            reason:
              status === "unsubscribed"
                ? "unsubscribed"
                : status === "bounced"
                  ? "bounced"
                  : "complained",
            source: status === "unsubscribed" ? "unsubscribe-link" : "resend-webhook",
            campaignId: id,
            contactId: person.id,
            detail:
              status === "unsubscribed"
                ? "Unsubscribed via the link in a WACA email."
                : "550 5.1.1 mailbox unavailable",
            createdAt: sent,
          });
          if (status === "unsubscribed") {
            unsubTokenRows.push({
              id: uid(),
              contactId: person.id,
              tokenHash: sha256(`demo-unsub-${rid}`),
              scope: "all",
              category: null,
              campaignId: id,
              expiresAt: null,
              usedAt: opened ?? sent,
              createdAt: sent,
            });
          }
        }
      }
    }

    const recipientCount = plan.status === "sent" ? people.length : 0;

    // The body is BLOCKS, and both rendered parts come from them through the
    // one renderer the composer uses. Seeding a hand-written html_body would
    // put rows in the database that the application itself could never have
    // produced -- and, because the review gate reads the rendered bytes, rows
    // that would fail their own CAN-SPAM check.
    const campaignBlocks: s.EmailBlock[] = [
      { type: "heading", level: 1, text: plan.subject },
      {
        type: "paragraph",
        html: `Dear {{first_name}}, here is the ${plan.name.toLowerCase()} for {{organization|your organisation}}.`,
      },
      ...template.blocks.filter((b) => b.type !== "heading"),
      {
        type: "member-data",
        heading: "Your WACA membership",
        fields: [
          { field: "organization", label: "Organisation", fallback: null },
          { field: "membership_level", label: "Level", fallback: null },
          { field: "renewal_date", label: "Renews", fallback: null },
        ],
      },
    ];
    const body = renderCampaign({
      subject: plan.subject,
      preheader: template.preheader,
      blocks: campaignBlocks,
      audienceNote: `You are receiving this because you are on WACA's \u201c${audience.name}\u201d list.`,
    });

    campaignRows.push({
      id,
      name: plan.name,
      templateId: template.id,
      audienceId: audience.id,
      subject: plan.subject,
      preheader: template.preheader,
      fromName: "Washington CannaBusiness Association",
      fromEmail: `news@waca.${EMAIL_DOMAIN}`,
      replyTo: `info@waca.${EMAIL_DOMAIN}`,
      category: plan.category,
      status: plan.status,
      blocks: campaignBlocks,
      htmlBody: body.html,
      // NOT NULL and non-empty for anything past draft -- see the CHECK.
      textBody: body.text,
      // A test send is a review-gate fact, not a claim. The two unsent
      // campaigns in the seed have had one; that is why they can be walked
      // through the gate in a demo.
      testSentAt: plan.status === "sent" ? sentAt : addDays(TODAY, -1),
      testSentTo: `staff@waca.${EMAIL_DOMAIN}`,
      scheduledAt: plan.status === "scheduled" ? addDays(TODAY, -plan.daysAgo) : null,
      sentAt,
      createdBy: chance(0.5) ? adminUser.id : staffUser.id,
      // The send gate. A 'sent' row cannot exist without all four of these.
      approvedBy: plan.status === "sent" ? adminUser.id : null,
      approvedAt: plan.status === "sent" ? addDays(sentAt!, 0) : null,
      sendConfirmationToken:
        plan.status === "sent" ? `demo-confirm-${id.slice(0, 22)}` : null,
      sendConfirmationExpiresAt: plan.status === "sent" ? addDays(sentAt!, 1) : null,
      sendConfirmedAt: plan.status === "sent" ? addDays(sentAt!, 0) : null,
      approvedRecipientCount: plan.status === "sent" ? recipientCount : null,
      recipientCount,
      sentCount: recipientCount,
      deliveredCount,
      uniqueOpenCount,
      uniqueClickCount,
      bounceCount,
      complaintCount,
      unsubscribeCount,
      failedCount: 0,
      suppressedCount: 0,
      createdAt: sentAt ? addDays(sentAt, -int(2, 9)) : addDays(TODAY, -int(1, 12)),
    });
  }

  await db.insert(s.campaigns).values(campaignRows);
  // Suppressions BEFORE recipients would refuse the very rows that recorded
  // the unsubscribe, so the historical recipient rows go in first and the
  // list follows. From here on the trigger governs: nothing may be added to a
  // campaign for an address on it.
  if (recipientRows.length) {
    for (let i = 0; i < recipientRows.length; i += 500) {
      await db.insert(s.campaignRecipients).values(recipientRows.slice(i, i + 500));
    }
  }
  if (suppressionRows.length) await db.insert(s.suppressions).values(suppressionRows);

  // A few live, unredeemed unsubscribe links, so the public page is testable.
  for (let i = 0; i < 12; i++) {
    const c = mailableContacts[int(0, mailableContacts.length - 1)];
    unsubTokenRows.push({
      id: uid(),
      contactId: c.id,
      tokenHash: sha256(`demo-unsub-live-${i}-${c.id}`),
      scope: i < 9 ? "all" : "category",
      category: i < 9 ? null : "fundraising",
      campaignId: campaignRows[campaignRows.length - 3].id,
      expiresAt: null,
      usedAt: null,
      createdAt: addDays(TODAY, -int(1, 40)),
    });
  }
  if (unsubTokenRows.length)
    await db.insert(s.unsubscribeTokens).values(unsubTokenRows);

  // Provider webhook events for the two most recent sends, deduped on
  // provider_event_id exactly as the real webhook would be.
  const recentCampaignIds = campaignRows
    .filter((c) => c.status === "sent")
    .slice(-2)
    .map((c) => c.id);
  const eventRowsEmail: (typeof s.emailEvents.$inferInsert)[] = [];
  for (const r of recipientRows.filter((r) => recentCampaignIds.includes(r.campaignId as string))) {
    const base = (r.sentAt as Date) ?? TODAY;
    eventRowsEmail.push({
      id: uid(),
      provider: "resend",
      providerEventId: `evt_${(r.id as string).replace(/-/g, "").slice(0, 24)}_sent`,
      eventType: "email.sent",
      providerMessageId: r.providerMessageId as string,
      campaignId: r.campaignId as string,
      recipientId: r.id as string,
      contactId: r.contactId as string,
      email: r.email as string,
      payload: { demo: true },
      occurredAt: base,
      processedAt: base,
    });
    if (r.firstOpenedAt) {
      eventRowsEmail.push({
        id: uid(),
        provider: "resend",
        providerEventId: `evt_${(r.id as string).replace(/-/g, "").slice(0, 24)}_open`,
        eventType: "email.opened",
        providerMessageId: r.providerMessageId as string,
        campaignId: r.campaignId as string,
        recipientId: r.id as string,
        contactId: r.contactId as string,
        email: r.email as string,
        payload: { demo: true },
        occurredAt: r.firstOpenedAt as Date,
        processedAt: r.firstOpenedAt as Date,
      });
    }
  }
  for (let i = 0; i < eventRowsEmail.length; i += 500) {
    await db.insert(s.emailEvents).values(eventRowsEmail.slice(i, i + 500));
  }

  // Record the real resolved size on each audience, using the same numbers the
  // admin screen will compute.
  for (const a of audienceRows) {
    const people = audienceContacts(a.name);
    await db.execute(sql`
      UPDATE audiences SET last_resolved_count = ${people.length},
                           last_resolved_at = ${TODAY.toISOString()}::timestamptz
       WHERE id = ${a.id}::uuid
    `);
    if (!a.isDynamic && people.length) {
      await db.insert(s.audienceMembers).values(
        people.map((p) => ({
          id: uid(),
          audienceId: a.id,
          contactId: p.id,
          email: p.email.toLowerCase(),
          addedAt: a.snapshotTakenAt ?? TODAY,
        })),
      );
    }
  }

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
    "content_types","content_items","content_revisions",
    "content_revision_sequences","content_assets","content_publishes",
    "audiences","audience_members","email_templates","campaigns",
    "campaign_recipients","email_events","suppressions","unsubscribe_tokens",
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
