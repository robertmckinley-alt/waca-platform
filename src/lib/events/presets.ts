/**
 * The REAL vocabulary in use at WACA, lifted from the live Wild Apricot
 * account. These are one-click presets in the admin, not an enum: staff can
 * still type anything. Prices are integer cents and are starting points only.
 */

export interface TicketTypePreset {
  name: string;
  description?: string;
  priceCents: number;
  memberOnly: boolean;
  /** Comps and internal rows: never shown on the public event page. */
  isInternal: boolean;
  sortOrder: number;
}

export const TICKET_TYPE_PRESETS: TicketTypePreset[] = [
  {
    name: "Attendee",
    description: "Standard attendee registration.",
    priceCents: 25000,
    memberOnly: false,
    isInternal: false,
    sortOrder: 10,
  },
  {
    name: "Event Registration – No Wine Tasting",
    description: "Full conference access, wine tasting excluded.",
    priceCents: 45000,
    memberOnly: false,
    isInternal: false,
    sortOrder: 20,
  },
  {
    name: "Full Event Registration with Wine",
    description: "Full conference access including the wine tasting.",
    priceCents: 55000,
    memberOnly: false,
    isInternal: false,
    sortOrder: 30,
  },
  {
    name: "Full Event Registration with Golf",
    description: "Full conference access including the golf tournament.",
    priceCents: 60000,
    memberOnly: false,
    isInternal: false,
    sortOrder: 40,
  },
  {
    name: "Wine Tour OR Golf Only",
    description: "Social programme only, no conference sessions.",
    priceCents: 17500,
    memberOnly: false,
    isInternal: false,
    sortOrder: 50,
  },
  {
    name: "Wine Tour Guest",
    description: "Guest of a registered attendee, wine tour only.",
    priceCents: 12500,
    memberOnly: false,
    isInternal: false,
    sortOrder: 60,
  },
  {
    name: "Speaker",
    description: "Comped speaker registration.",
    priceCents: 0,
    memberOnly: false,
    isInternal: true,
    sortOrder: 70,
  },
  {
    name: "Sponsor Attendee",
    description: "Included with a sponsorship package.",
    priceCents: 0,
    memberOnly: false,
    isInternal: true,
    sortOrder: 80,
  },
  {
    name: "Staff",
    description: "WACA staff.",
    priceCents: 0,
    memberOnly: false,
    isInternal: true,
    sortOrder: 90,
  },
  {
    name: "Staff/Special Guest",
    description: "WACA staff, legislators and invited guests.",
    priceCents: 0,
    memberOnly: false,
    isInternal: true,
    sortOrder: 100,
  },
];

export interface SponsorTierPreset {
  name: string;
  priceCents: number;
  inventory: number | null;
  includedTickets: number;
  benefits: string[];
  sortOrder: number;
}

export const SPONSOR_TIER_PRESETS: SponsorTierPreset[] = [
  {
    name: "Diamond",
    priceCents: 2500000,
    inventory: 1,
    includedTickets: 10,
    benefits: [
      "Exclusive title billing on all event materials",
      "Podium time at the opening plenary",
      "Premium exhibit placement",
      "Full attendee list (opt-in only)",
      "Logo on the main stage backdrop",
    ],
    sortOrder: 10,
  },
  {
    name: "Platinum",
    priceCents: 1500000,
    inventory: 2,
    includedTickets: 8,
    benefits: [
      "Logo on all event materials",
      "Exhibit table in the main hall",
      "Recognition from the podium",
      "Full-page programme advert",
    ],
    sortOrder: 20,
  },
  {
    name: "Gold",
    priceCents: 1000000,
    inventory: 4,
    includedTickets: 6,
    benefits: [
      "Logo on event materials",
      "Exhibit table",
      "Half-page programme advert",
    ],
    sortOrder: 30,
  },
  {
    name: "Silver",
    priceCents: 500000,
    inventory: 8,
    includedTickets: 4,
    benefits: ["Logo on event materials", "Quarter-page programme advert"],
    sortOrder: 40,
  },
  {
    name: "Breakfast",
    priceCents: 350000,
    inventory: 2,
    includedTickets: 2,
    benefits: ["Signage at the breakfast service", "Recognition in the programme"],
    sortOrder: 50,
  },
  {
    name: "Lunch",
    priceCents: 450000,
    inventory: 2,
    includedTickets: 2,
    benefits: ["Signage at the lunch service", "Recognition in the programme"],
    sortOrder: 60,
  },
  {
    name: "Coffee",
    priceCents: 250000,
    inventory: 3,
    includedTickets: 2,
    benefits: ["Signage at the coffee stations", "Logo on cups"],
    sortOrder: 70,
  },
  {
    name: "Cocktail",
    priceCents: 500000,
    inventory: 2,
    includedTickets: 4,
    benefits: [
      "Signage at the reception bar",
      "Branded cocktail napkins",
      "Recognition from the podium at the reception",
    ],
    sortOrder: 80,
  },
  {
    name: "Wine",
    priceCents: 400000,
    inventory: 2,
    includedTickets: 4,
    benefits: ["Signage at the wine tasting", "Logo on tasting cards"],
    sortOrder: 90,
  },
  {
    name: "Lanyard",
    priceCents: 300000,
    inventory: 1,
    includedTickets: 2,
    benefits: ["Logo on every attendee lanyard"],
    sortOrder: 100,
  },
  {
    name: "Hole",
    priceCents: 100000,
    inventory: 18,
    includedTickets: 0,
    benefits: ["Signage at one golf hole", "Recognition in the golf programme"],
    sortOrder: 110,
  },
  {
    name: "Swag Bag",
    priceCents: 350000,
    inventory: 1,
    includedTickets: 2,
    benefits: ["Logo on the attendee swag bag", "Insert in every bag"],
    sortOrder: 120,
  },
];

export const SPONSOR_TIER_NAMES = SPONSOR_TIER_PRESETS.map((t) => t.name);
export const TICKET_TYPE_NAMES = TICKET_TYPE_PRESETS.map((t) => t.name);
