import { config } from "dotenv";
import postgres from "postgres";

config({ path: ".env.local", quiet: true });

/**
 * Removes what the journey spec created, so the suite can be run repeatedly
 * against the same seed without piling up "E2E Policy Briefing …" events and
 * their invoices.
 *
 * Scoped by name prefix and deleted in FK order. It never touches a row it
 * did not create — no truncate, no cascade off a whole table.
 *
 * Invoice NUMBERS are deliberately not reclaimed: the sequence is meant to be
 * gap-free going forward, not rewritable. A run consumes a few numbers and
 * that is the honest record of what happened.
 */
export default async function globalTeardown() {
  const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) return;
  const sql = postgres(url, { max: 1, prepare: false });

  try {
    // Documents created by 04-documents.spec.ts.
    const docs = await sql<{ id: string }[]>`
      select id from documents where title like 'E2E %'`;
    if (docs.length) {
      const docIds = docs.map((d) => d.id);
      await sql`delete from document_downloads where document_id = any(${docIds}::uuid[])`;
      await sql`delete from documents where id = any(${docIds}::uuid[])`;
      console.log(`[e2e] cleaned up ${docIds.length} test document(s)`);
    }

    const events = await sql<{ id: string }[]>`
      select id from events where name like 'E2E %'`;
    if (events.length === 0) return;

    const ids = events.map((e) => e.id);

    const invoices = await sql<{ id: string }[]>`
      select id from invoices where event_id = any(${ids}::uuid[])`;
    const invoiceIds = invoices.map((i) => i.id);

    if (invoiceIds.length) {
      await sql`delete from payment_allocations where invoice_id = any(${invoiceIds}::uuid[])`;
      await sql`delete from invoice_lines where invoice_id = any(${invoiceIds}::uuid[])`;
    }
    await sql`update registrations set invoice_id = null where event_id = any(${ids}::uuid[])`;
    if (invoiceIds.length) {
      await sql`delete from invoices where id = any(${invoiceIds}::uuid[])`;
    }

    await sql`delete from registrations where event_id = any(${ids}::uuid[])`;
    await sql`delete from event_sponsorships where event_id = any(${ids}::uuid[])`;
    await sql`delete from ticket_types where event_id = any(${ids}::uuid[])`;
    await sql`delete from sponsor_tiers where event_id = any(${ids}::uuid[])`;
    await sql`delete from event_sessions where event_id = any(${ids}::uuid[])`;
    await sql`update documents set event_id = null where event_id = any(${ids}::uuid[])`;
    await sql`delete from events where id = any(${ids}::uuid[])`;

    console.log(`[e2e] cleaned up ${ids.length} test event(s)`);
  } finally {
    await sql.end();
  }
}
