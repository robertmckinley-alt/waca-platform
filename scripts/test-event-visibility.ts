/**
 * EVENT VISIBILITY TEST
 *
 * Run:  npx tsx --env-file=.env.local scripts/test-event-visibility.ts
 *       (or: npm run test:events)
 *
 * The single rule this file exists to defend:
 *
 *   A non-public event must never appear in the public list, must never be
 *   reachable by guessing its slug, and must never be registrable — and that
 *   has to be enforced in the QUERY HELPER, not in a component, so no future
 *   page can forget it.
 *
 * WACA runs legislator and congressional fundraisers that are not public.
 * Leaking one is the kind of mistake that ends up in a newspaper, so every
 * path that can return an event is checked here: listEvents, getEventDetail
 * (by id AND by slug), the public JSON API, and the registration flow.
 */

import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { events, registrations } from "@/db/schema";
import {
  PUBLIC_VIEWER,
  getEventDetail,
  listEvents,
  viewerFromContact,
  type Viewer,
} from "@/db/queries";
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

async function listAll(viewer: Viewer) {
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    const result = await listEvents({ viewer, page, pageSize: 200 });
    rows.push(...result.rows);
    if (page >= result.pageCount) break;
  }
  return rows;
}

async function main() {
  const all = await db.select().from(events);
  const nonPublic = all.filter((e) => e.visibility !== "public");
  const publicVisible = all.filter(
    (e) =>
      e.visibility === "public" &&
      (e.status === "published" || e.status === "completed"),
  );

  console.log(
    `\nFixtures: ${all.length} events — ${publicVisible.length} public+visible, ` +
      `${nonPublic.length} non-public ` +
      `(${all.filter((e) => e.visibility === "admin-only").length} admin-only, ` +
      `${all.filter((e) => e.visibility === "invite-only").length} invite-only, ` +
      `${all.filter((e) => e.visibility === "members-only").length} members-only).`,
  );

  check(
    "fixtures include at least one admin-only and one invite-only event",
    all.some((e) => e.visibility === "admin-only") &&
      all.some((e) => e.visibility === "invite-only"),
    "the seed must keep the non-public fundraisers or this test proves nothing",
  );

  /* ---------------------------------------------------------------- anon */

  console.log("\nAnonymous visitor (PUBLIC_VIEWER)");
  const anonRows = await listAll(PUBLIC_VIEWER);

  check(
    "listEvents returns only public events",
    anonRows.every((e) => e.visibility === "public"),
    anonRows
      .filter((e) => e.visibility !== "public")
      .map((e) => `${e.slug}:${e.visibility}`)
      .join(", "),
  );

  check(
    "listEvents returns only published or completed events",
    anonRows.every((e) => e.status === "published" || e.status === "completed"),
    anonRows
      .filter((e) => e.status !== "published" && e.status !== "completed")
      .map((e) => `${e.slug}:${e.status}`)
      .join(", "),
  );

  check(
    "listEvents shows every public event (the gate is not vacuous)",
    anonRows.length === publicVisible.length,
    `saw ${anonRows.length}, expected ${publicVisible.length}`,
  );

  const leakedById: string[] = [];
  const leakedBySlug: string[] = [];
  for (const e of nonPublic) {
    if (await getEventDetail(e.id, PUBLIC_VIEWER)) leakedById.push(e.slug);
    if (await getEventDetail(e.slug, PUBLIC_VIEWER)) leakedBySlug.push(e.slug);
  }
  check(
    "getEventDetail by id returns null for every non-public event",
    leakedById.length === 0,
    leakedById.join(", "),
  );
  check(
    "getEventDetail by GUESSED SLUG returns null for every non-public event",
    leakedBySlug.length === 0,
    leakedBySlug.join(", "),
  );

  const adminOnly = all.find((e) => e.visibility === "admin-only");
  if (adminOnly) {
    check(
      `admin-only fundraiser "${adminOnly.name}" is invisible to the public`,
      (await getEventDetail(adminOnly.slug, PUBLIC_VIEWER)) === null,
    );
  }

  /* -------------------------------------------------------------- member */

  console.log("\nActive member");
  const [memberRow] = await db.execute<{ contact_id: string }>(sql`
    select c.id as contact_id
      from contacts c
      join memberships m on m.organization_id = c.organization_id
     where m.status = 'active' and m.is_current
       and c.id not in (
         select r.contact_id from registrations r
           join events e on e.id = r.event_id
          where e.visibility = 'invite-only' and r.contact_id is not null
       )
     limit 1
  `);

  if (!memberRow) {
    check("found an active member fixture", false, "no seeded active member");
  } else {
    const member = await viewerFromContact(memberRow.contact_id);
    const memberRows = await listAll(member);

    check(
      "member sees no admin-only event",
      memberRows.every((e) => e.visibility !== "admin-only"),
      memberRows.filter((e) => e.visibility === "admin-only").map((e) => e.slug).join(", "),
    );
    check(
      "member sees members-only events",
      memberRows.some((e) => e.visibility === "members-only"),
    );
    check(
      "member sees no invite-only event they are not registered for",
      memberRows.every((e) => e.visibility !== "invite-only"),
      memberRows.filter((e) => e.visibility === "invite-only").map((e) => e.slug).join(", "),
    );
    if (adminOnly) {
      check(
        "member cannot open the admin-only fundraiser by slug",
        (await getEventDetail(adminOnly.slug, member)) === null,
      );
    }
  }

  /* ---------------------------------------------------------- invite-only */

  console.log("\nInvitee of an invite-only event");
  const inviteOnly = all.find((e) => e.visibility === "invite-only");
  if (inviteOnly) {
    const [invitee] = await db
      .select({ contactId: registrations.contactId })
      .from(registrations)
      .where(
        sql`${registrations.eventId} = ${inviteOnly.id} and ${registrations.contactId} is not null`,
      )
      .limit(1);

    if (invitee?.contactId) {
      const inviteeViewer = await viewerFromContact(invitee.contactId);
      check(
        "an invited contact CAN see their invite-only event",
        (await getEventDetail(inviteOnly.slug, inviteeViewer)) !== null,
      );
      const inviteeRows = await listAll(inviteeViewer);
      check(
        "the invite-only event appears in that invitee's list",
        inviteeRows.some((e) => e.id === inviteOnly.id),
      );
      check(
        "the invitee still cannot see admin-only events",
        inviteeRows.every((e) => e.visibility !== "admin-only"),
      );
    } else {
      check("found an invitee fixture", false, "no registration with a contact");
    }
  }

  /* --------------------------------------------------------------- staff */

  console.log("\nStaff");
  const staff: Viewer = {
    ...PUBLIC_VIEWER,
    userId: "00000000-0000-0000-0000-000000000000",
    role: "staff",
  };
  const staffRows = await listAll(staff);
  check(
    "staff see every event, including the non-public fundraisers",
    staffRows.length === all.length,
    `saw ${staffRows.length} of ${all.length}`,
  );

  /* ------------------------------------------- freshly inserted edge cases */

  console.log("\nDraft and cancelled events (inserted, then removed)");
  const stamp = Date.now();
  const inserted = await db
    .insert(events)
    .values([
      {
        name: "TEST draft public event",
        slug: `test-draft-public-${stamp}`,
        kind: "webinar",
        status: "draft",
        visibility: "public",
        startsAt: new Date(Date.now() + 86_400_000),
      },
      {
        name: "TEST cancelled public event",
        slug: `test-cancelled-public-${stamp}`,
        kind: "webinar",
        status: "cancelled",
        visibility: "public",
        startsAt: new Date(Date.now() + 86_400_000),
      },
      {
        name: "TEST admin-only published fundraiser",
        slug: `test-admin-only-${stamp}`,
        kind: "fundraiser",
        status: "published",
        visibility: "admin-only",
        startsAt: new Date(Date.now() + 86_400_000),
      },
    ])
    .returning({ id: events.id, slug: events.slug, status: events.status });

  try {
    const draft = inserted.find((e) => e.status === "draft")!;
    const cancelled = inserted.find((e) => e.status === "cancelled")!;
    const hiddenFundraiser = inserted.find((e) => e.slug.includes("admin-only"))!;

    check(
      "a DRAFT public event is invisible to the public",
      (await getEventDetail(draft.slug, PUBLIC_VIEWER)) === null,
    );
    check(
      "a CANCELLED public event is invisible to the public",
      (await getEventDetail(cancelled.slug, PUBLIC_VIEWER)) === null,
    );
    check(
      "a PUBLISHED admin-only event is invisible to the public",
      (await getEventDetail(hiddenFundraiser.slug, PUBLIC_VIEWER)) === null,
    );
    check(
      "none of the three appear in the anonymous list",
      (await listAll(PUBLIC_VIEWER)).every(
        (e) => !inserted.some((i) => i.id === e.id),
      ),
    );

    /* ------------------------------------------------- registration flow */

    console.log("\nRegistration flow");
    let code: string | null = null;
    try {
      await registerForEvent(
        {
          eventId: hiddenFundraiser.id,
          attendeeName: "Uninvited Guest",
          attendeeEmail: "uninvited@example.org",
          attendeeTitle: null,
          attendeeOrganizationName: null,
          dietaryNotes: null,
          accessibilityNotes: null,
          lines: [
            { ticketTypeId: "00000000-0000-0000-0000-000000000000", quantity: 1 },
          ],
          guests: [],
        },
        PUBLIC_VIEWER,
      );
    } catch (error) {
      code = error instanceof RegistrationError ? error.code : `other:${error}`;
    }
    check(
      "registering for a non-public event fails as not-found, not as forbidden",
      code === "not-found",
      `got ${code}`,
    );
  } finally {
    await db.delete(events).where(
      inArray(
        events.id,
        inserted.map((e) => e.id),
      ),
    );
  }

  /* ----------------------------------------------------------- JSON API */

  console.log("\nPublic JSON API (/api/events/upcoming)");
  const { GET } = await import("@/app/api/events/upcoming/route");
  const { NextRequest } = await import("next/server");
  const response = await GET(
    new NextRequest("http://localhost:3000/api/events/upcoming?limit=100"),
  );
  const body = (await response.json()) as {
    events: { slug: string }[];
  };
  const returnedSlugs = new Set(body.events.map((e) => e.slug));

  check(
    "the API never returns a non-public event",
    nonPublic.every((e) => !returnedSlugs.has(e.slug)),
    nonPublic.filter((e) => returnedSlugs.has(e.slug)).map((e) => e.slug).join(", "),
  );
  check(
    "the API response is cacheable at the edge",
    (response.headers.get("cache-control") ?? "").includes("s-maxage"),
    response.headers.get("cache-control") ?? "(none)",
  );

  const returned = await db
    .select({ visibility: events.visibility, status: events.status })
    .from(events)
    .where(
      returnedSlugs.size
        ? inArray(events.slug, [...returnedSlugs])
        : eq(events.slug, "__none__"),
    );
  check(
    "every event the API returned is public + published in the database",
    returned.every((e) => e.visibility === "public" && e.status === "published"),
  );

  /* -------------------------------------------------- internal ticket types */

  console.log("\nInternal ticket types");
  const withInternal = await db.execute<{ slug: string }>(sql`
    select e.slug from events e
      join ticket_types t on t.event_id = e.id
     where t.is_internal and e.visibility = 'public'
       and e.status in ('published','completed')
     limit 1
  `);
  const internalSlug = withInternal[0]?.slug;
  if (internalSlug) {
    const detail = await getEventDetail(internalSlug, PUBLIC_VIEWER);
    check(
      "staff/comp ticket types are not exposed to the public",
      detail !== null && detail.ticketTypes.every((t) => !t.isInternal),
    );
    check(
      "the public never receives another attendee's registration rows",
      detail !== null && detail.registrations.length === 0,
    );
  }

  /* --------------------------------------------------------------- report */

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
