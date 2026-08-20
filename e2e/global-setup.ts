import { config } from "dotenv";
import { writeFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

config({ path: ".env.local", quiet: true });

/**
 * Resolves the fixtures the suite needs out of the seeded database and writes
 * them to e2e/.fixtures.json.
 *
 * Deliberately NOT an API route. A `/api/e2e/...` endpoint that hands out
 * accounts and document ids would be a real backdoor shipped in the real
 * build, guarded by nothing but an environment variable somebody will
 * eventually get wrong. The test harness has database access; the application
 * does not need a test mode.
 */
export interface Fixtures {
  adminEmail: string;
  staffEmail: string;
  memberEmail: string;
  memberContactId: string;
  bundleAdminEmail: string;
  /** A published, public event the member and the world may both see. */
  publicEventSlug: string;
  /**
   * A members-only event. A signed-in member SHOULD see this — it is the
   * positive control that stops "member cannot see X" passing because the
   * member can see nothing.
   */
  membersOnlyEventSlug: string;
  /**
   * An admin-only or invite-only event — the legislator and congressional
   * fundraisers. Must never reach the public API, and must not be reachable
   * by an ordinary member who guesses the slug.
   */
  restrictedEventSlug: string;
  restrictedEventId: string;
  /** A document the demo member may NOT read. */
  forbiddenDocumentId: string;
  forbiddenDocumentTitle: string;
  /** A document the demo member MAY read. */
  permittedDocumentTitle: string;
  organizationId: string;
  /** An unsent campaign — the builder, preview and review gate. */
  draftCampaignId: string;
  /** A campaign that has been sent — the report and its CSV export. */
  sentCampaignId: string;
  /** A saved audience — the segment builder. */
  audienceId: string;
  /** An email template. */
  templateId: string;
}

export default async function globalSetup() {
  const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { max: 1, prepare: false });

  const [member] = await sql`
    select u.email, u.contact_id, c.organization_id
      from users u join contacts c on c.id = u.contact_id
     where u.role = 'member' limit 1`;
  if (!member) throw new Error("No demo member user in the database — run npm run db:reset");

  const [admin] = await sql`select email from users where role = 'admin' limit 1`;
  const [staff] = await sql`select email from users where role = 'staff' limit 1`;
  const [bundleAdmin] = await sql`select email from users where role = 'bundle_admin' limit 1`;

  const [publicEvent] = await sql`
    select slug from events
     where visibility = 'public' and status in ('published','completed')
     order by starts_at desc limit 1`;

  const [membersOnlyEvent] = await sql`
    select slug from events
     where visibility = 'members-only' and status in ('published','completed')
     order by starts_at desc limit 1`;

  // NOT members-only: a member is entitled to those. The events that must
  // stay invisible are the admin-only and invite-only fundraisers.
  const [restrictedEvent] = await sql`
    select id, slug from events
     where visibility in ('admin-only','invite-only')
     order by starts_at desc limit 1`;

  // A document this member must not be able to reach: council-restricted to a
  // council they do not sit on, or level-restricted to a level they are not on.
  const [forbidden] = await sql`
    select d.id, d.title from documents d
     where d.published_on is not null
       and d.archived_at is null
       and d.access_scope = 'council-restricted'
       and not exists (
         select 1 from council_members cm
          where cm.contact_id = ${member.contact_id}
            and cm.is_active
            and cm.council_id = any(d.council_restrictions)
       )
     limit 1`;

  const [permitted] = await sql`
    select title from documents
     where published_on is not null and archived_at is null
       and access_scope = 'members'
     limit 1`;

  const [draftCampaign] = await sql`
    select id from campaigns where status in ('draft','ready','scheduled')
     order by created_at desc limit 1`;
  const [sentCampaign] = await sql`
    select id from campaigns where status = 'sent'
     order by sent_at desc limit 1`;
  const [audience] = await sql`
    select id from audiences where archived_at is null order by name limit 1`;
  const [template] = await sql`
    select id from email_templates where archived_at is null order by name limit 1`;

  await sql.end();

  const missing: string[] = [];
  if (!publicEvent) missing.push("a public published event");
  if (!membersOnlyEvent) missing.push("a members-only event");
  if (!restrictedEvent) missing.push("an admin-only or invite-only event");
  if (!forbidden) missing.push("a council-restricted document the member cannot read");
  if (!permitted) missing.push("a members-scope document");
  if (!draftCampaign) missing.push("an unsent campaign");
  if (!sentCampaign) missing.push("a sent campaign");
  if (!audience) missing.push("a saved audience");
  if (!template) missing.push("an email template");
  if (missing.length) {
    throw new Error(
      `The seed does not contain ${missing.join(", ")}. The security tests ` +
        `would pass vacuously, so the suite refuses to run. Re-seed with ` +
        `npm run db:reset.`,
    );
  }

  const fixtures: Fixtures = {
    adminEmail: admin.email,
    staffEmail: staff.email,
    memberEmail: member.email,
    memberContactId: member.contact_id,
    bundleAdminEmail: bundleAdmin.email,
    publicEventSlug: publicEvent.slug,
    membersOnlyEventSlug: membersOnlyEvent.slug,
    restrictedEventSlug: restrictedEvent.slug,
    restrictedEventId: restrictedEvent.id,
    forbiddenDocumentId: forbidden.id,
    forbiddenDocumentTitle: forbidden.title,
    permittedDocumentTitle: permitted.title,
    organizationId: member.organization_id,
    draftCampaignId: draftCampaign.id,
    sentCampaignId: sentCampaign.id,
    audienceId: audience.id,
    templateId: template.id,
  };

  writeFileSync(
    path.join(process.cwd(), "e2e", ".fixtures.json"),
    JSON.stringify(fixtures, null, 2),
  );
  console.log(`[e2e] fixtures resolved for ${fixtures.memberEmail}`);
}
