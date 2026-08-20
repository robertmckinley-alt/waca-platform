import { and, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { registrations } from "@/db/schema";

/**
 * Live seat counts for a set of ticket types. Counted from registrations
 * rather than trusting the cached ticket_types.sold_count, because the door
 * screen and staff edits move rows around underneath it.
 *
 * Callers must already have passed the event through the visibility gate.
 */
export interface TicketAvailability {
  taken: number;
  /** null = uncapped. */
  remaining: number | null;
  soldOut: boolean;
}

export async function ticketAvailability(
  eventId: string,
  tickets: { id: string; capacity: number | null }[],
  opts: { db?: typeof defaultDb } = {},
): Promise<Map<string, TicketAvailability>> {
  const database = opts.db ?? defaultDb;
  const out = new Map<string, TicketAvailability>();
  if (!tickets.length) return out;

  const rows = await database
    .select({
      ticketTypeId: registrations.ticketTypeId,
      taken: sql<number>`count(*) filter (where ${registrations.status} in ('pending','confirmed'))::int`,
    })
    .from(registrations)
    .where(
      and(
        eq(registrations.eventId, eventId),
        inArray(
          registrations.ticketTypeId,
          tickets.map((t) => t.id),
        ),
      ),
    )
    .groupBy(registrations.ticketTypeId);

  const takenBy = new Map(rows.map((r) => [r.ticketTypeId, Number(r.taken)]));

  for (const t of tickets) {
    const taken = takenBy.get(t.id) ?? 0;
    const remaining = t.capacity == null ? null : Math.max(0, t.capacity - taken);
    out.set(t.id, { taken, remaining, soldOut: remaining !== null && remaining === 0 });
  }
  return out;
}
