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

    // CMS rows created by 06-cms.spec.ts. Scoped by slug prefix; revisions
    // and the revision sequence go first because both point at the item.
    const cmsItems = await sql<{ id: string }[]>`
      select id from content_items where slug like 'e2e-%'`;
    if (cmsItems.length) {
      const cmsIds = cmsItems.map((i) => i.id);
      // A publish run records the ids it promoted. Strip them out rather than
      // deleting the run: the publish log is an audit trail, and a run that
      // happened should keep saying so.
      await sql`
        update content_publishes
           set item_ids = (
                 select coalesce(array_agg(x), '{}')
                   from unnest(item_ids) x
                  where x <> all(${cmsIds}::uuid[]))
         where item_ids && ${cmsIds}::uuid[]`;
      // status and published_revision_id move together: CHECK
      // content_items_published_needs_revision refuses a 'published' row with
      // no revision, so clearing one without the other fails. The journey
      // spec publishes what it creates, which is how that was found.
      await sql`
        update content_items
           set published_revision_id = null, status = 'draft'
         where id = any(${cmsIds}::uuid[])`;
      await sql`delete from content_revisions where item_id = any(${cmsIds}::uuid[])`;
      await sql`delete from content_revision_sequences where item_id = any(${cmsIds}::uuid[])`;
      await sql`delete from content_items where id = any(${cmsIds}::uuid[])`;
      console.log(`[e2e] cleaned up ${cmsIds.length} test content item(s)`);
    }

    /* Email rows created by 07-journeys.spec.ts. Recipients first (they point
     * at the campaign), then the campaign, then the audience — and the
     * unsubscribe tokens the dry-run dispatch minted per recipient, which
     * belong to that campaign and to nothing else. */
    const journeyCampaigns = await sql<{ id: string }[]>`
      select id from campaigns where name like 'E2E journey campaign %'`;
    if (journeyCampaigns.length) {
      const ids = journeyCampaigns.map((c) => c.id);
      await sql`delete from email_events where campaign_id = any(${ids}::uuid[])`;
      await sql`delete from unsubscribe_tokens where campaign_id = any(${ids}::uuid[])`;
      await sql`delete from campaign_recipients where campaign_id = any(${ids}::uuid[])`;
      await sql`delete from suppressions where campaign_id = any(${ids}::uuid[])`;
      await sql`delete from campaigns where id = any(${ids}::uuid[])`;
      console.log(`[e2e] cleaned up ${ids.length} test campaign(s)`);
    }
    const journeyAudiences = await sql<{ id: string }[]>`
      select id from audiences where name like 'E2E journey audience %'`;
    if (journeyAudiences.length) {
      const ids = journeyAudiences.map((a) => a.id);
      await sql`delete from audience_members where audience_id = any(${ids}::uuid[])`;
      await sql`delete from audiences where id = any(${ids}::uuid[])`;
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
