import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Badge } from "@/components/ui/primitives";
import { RegistrationForm } from "@/components/events/registration-form";
import { auth } from "@/auth";
import { getEventDetail } from "@/db/queries";
import { ticketAvailability } from "@/lib/events/availability";
import {
  EVENT_KIND_LABELS,
  formatDateRange,
  formatDateTime,
  formatEventTime,
  registrationWindowState,
} from "@/lib/events/format";
import { getViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";

/**
 * PUBLIC EVENT PAGE.
 *
 * getEventDetail() returns null both when the slug does not exist and when
 * this viewer may not see it, and both cases render the same 404 — so
 * guessing the slug of a legislator fundraiser tells you nothing about
 * whether it exists.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const viewer = await getViewer();
  const { slug } = await params;
  const detail = await getEventDetail(slug, viewer);
  if (!detail) return { title: "Event not found" };
  return {
    title: detail.event.name,
    description: detail.event.summary ?? undefined,
    robots: detail.event.visibility === "public" ? undefined : { index: false },
  };
}

export default async function PublicEventPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const viewer = await getViewer();
  const session = await auth();
  const { slug } = await params;

  const detail = await getEventDetail(slug, viewer);
  if (!detail) notFound();

  const { event, sessions, ticketTypes, sponsorTiers, myRegistrations } = detail;
  const windowState = registrationWindowState(event);
  const availability = await ticketAvailability(
    event.id,
    ticketTypes.map((t) => ({ id: t.id, capacity: t.capacity })),
  );

  const now = Date.now();
  const publicTickets = ticketTypes
    .filter((t) => t.isActive && !t.isInternal)
    .map((t) => {
      const a = availability.get(t.id);
      return {
        id: t.id,
        name: t.name,
        description: t.description,
        priceCents: Number(t.priceCents),
        memberOnly: t.memberOnly,
        minPerOrder: t.minPerOrder,
        maxPerOrder: t.maxPerOrder,
        remaining: a?.remaining ?? null,
        soldOut: a?.soldOut ?? false,
        onSale:
          (!t.availableFrom || t.availableFrom.getTime() <= now) &&
          (!t.availableUntil || t.availableUntil.getTime() >= now),
      };
    });

  return (
    <article className="grid gap-8 lg:grid-cols-[3fr_2fr]">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="muted">{EVENT_KIND_LABELS[event.kind]}</Badge>
          {event.visibility === "members-only" ? (
            <Badge tone="warning">Members only</Badge>
          ) : null}
          {event.status === "cancelled" ? <Badge tone="danger">Cancelled</Badge> : null}
        </div>

        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-900">
          {event.name}
        </h1>
        <p className="mt-1 text-[14px] text-zinc-600">
          {formatDateRange(event.startsAt, event.endsAt)}
          {event.isVirtual
            ? " · Online"
            : event.venueName
              ? ` · ${[event.venueName, event.city, event.state].filter(Boolean).join(", ")}`
              : ""}
        </p>

        {event.summary ? (
          <p className="mt-4 text-[15px] text-zinc-800">{event.summary}</p>
        ) : null}
        {event.description ? (
          <div className="mt-3 whitespace-pre-line text-[14px] leading-relaxed text-zinc-700">
            {event.description}
          </div>
        ) : null}

        {sessions.length > 0 ? (
          <section className="mt-8">
            <h2 className="text-[15px] font-semibold text-zinc-900">Agenda</h2>
            <ul className="mt-2 divide-y divide-zinc-100 border-t border-zinc-100">
              {sessions.map((s) => (
                <li key={s.id} className="flex gap-4 py-3">
                  <span className="w-28 shrink-0 text-[13px] tabular text-zinc-500">
                    {formatEventTime(s.startsAt)}
                  </span>
                  <span>
                    <span className="block text-[14px] font-medium text-zinc-900">
                      {s.title}
                    </span>
                    {s.room ? (
                      <span className="block text-[12px] text-zinc-500">{s.room}</span>
                    ) : null}
                    {s.description ? (
                      <span className="mt-0.5 block text-[13px] text-zinc-600">
                        {s.description}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {sponsorTiers.filter((t) => t.isActive).length > 0 ? (
          <section className="mt-8">
            <h2 className="text-[15px] font-semibold text-zinc-900">Sponsorship</h2>
            <p className="mt-1 text-[13px] text-zinc-600">
              To sponsor this event, contact{" "}
              <a className="underline" href={`mailto:${event.contactEmail ?? "events@example.org"}`}>
                {event.contactEmail ?? "events@example.org"}
              </a>
              .
            </p>
            <ul className="mt-2 grid gap-2 sm:grid-cols-2">
              {sponsorTiers
                .filter((t) => t.isActive)
                .map((t) => (
                  <li key={t.id} className="rounded border border-zinc-200 p-3">
                    <span className="text-[14px] font-medium text-zinc-900">{t.name}</span>
                    {t.benefits.length ? (
                      <ul className="mt-1 list-inside list-disc text-[12px] text-zinc-600">
                        {t.benefits.slice(0, 4).map((b) => (
                          <li key={b}>{b}</li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
            </ul>
          </section>
        ) : null}
      </div>

      <aside className="lg:sticky lg:top-6 lg:self-start">
        <div className="rounded-lg border border-zinc-200 p-4">
          <h2 className="text-[15px] font-semibold text-zinc-900">Registration</h2>

          {myRegistrations.filter((r) => r.status !== "cancelled").length > 0 ? (
            <div className="mt-2 rounded border border-zinc-200 bg-zinc-50 p-3 text-[13px] text-zinc-700">
              You are already registered for this event
              {myRegistrations[0]?.status === "waitlisted" ? " (waitlisted)" : ""}. See{" "}
              <Link href="/portal" className="underline">
                your portal
              </Link>{" "}
              for the details.
            </div>
          ) : null}

          {windowState === "open" ? (
            <div className="mt-3">
              <RegistrationForm
                eventId={event.id}
                tickets={publicTickets}
                waitlistEnabled={event.waitlistEnabled}
                signedIn={Boolean(session?.user)}
                defaults={{
                  name: session?.user?.name ?? "",
                  email: session?.user?.email ?? "",
                  organization: "",
                }}
              />
            </div>
          ) : (
            <p className="mt-2 text-[13px] text-zinc-600">
              {windowState === "not-yet-open"
                ? `Registration opens ${formatDateTime(event.registrationOpensAt)}.`
                : "Registration is closed for this event."}
            </p>
          )}
        </div>
      </aside>
    </article>
  );
}
