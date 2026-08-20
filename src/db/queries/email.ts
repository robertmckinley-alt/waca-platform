import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { db as defaultDb, type DbExecutor } from "@/db";
import {
  audienceMembers,
  audiences,
  campaignRecipients,
  campaigns,
  contacts,
  emailTemplates,
  suppressions,
  unsubscribeTokens,
  type AudienceCondition,
  type AudienceRule,
} from "@/db/schema";
import {
  paginate,
  resolvePaging,
  type PageParams,
  type Paginated,
  type SortDirection,
  type WithExecutor,
} from "./types";

/**
 * ============================================================================
 *  EMAIL QUERY HELPERS -- segmentation, campaigns, suppression.
 *
 *  Module agents: import from "@/db/queries". Three rules, none optional.
 *
 *  1. NEVER insert into campaign_recipients yourself. Call buildRecipients().
 *     It anti-joins the suppression list in SQL. The database will refuse a
 *     suppressed address anyway (trigger, migration 0006), but a refusal that
 *     aborts a 3,000-row insert halfway is not a plan.
 *
 *  2. NEVER set campaigns.status = 'sending' with a plain UPDATE. Call
 *     beginCampaignSend(), which redeems the confirmation token in the same
 *     statement and treats "zero rows updated" as a refusal to send. The
 *     CHECK constraint and the trigger will stop you, loudly; this helper is
 *     how you were meant to do it.
 *
 *  3. resolveAudience() is the ONLY thing that turns a rule tree into
 *     contacts. previewAudienceCount() and buildRecipients() both go through
 *     it, so the number the approver was shown and the list that is actually
 *     mailed cannot come from two different predicates.
 * ============================================================================
 */

/** Re-exported so module agents can import the rule shapes from one place. */
export type { AudienceCondition, AudienceRule, EmailBlock } from "@/db/schema";

export type CampaignStatus = (typeof campaigns.$inferSelect)["status"];
export type RecipientStatus =
  (typeof campaignRecipients.$inferSelect)["status"];
export type SuppressionReason = (typeof suppressions.$inferSelect)["reason"];
export type EmailCategory = (typeof campaigns.$inferSelect)["category"];

/* ======================================================================
 *  AUDIENCE RULES
 * ==================================================================== */

const uuidList = z.array(z.uuid()).min(1).max(200);
const stringList = z.array(z.string().min(1).max(64)).min(1).max(200);

const conditionSchema: z.ZodType<AudienceCondition> = z.union([
  z.object({
    field: z.literal("membership_level"),
    op: z.enum(["in", "not_in"]),
    values: uuidList,
  }),
  z.object({
    field: z.literal("membership_status"),
    op: z.enum(["in", "not_in"]),
    values: stringList,
  }),
  z.object({
    field: z.literal("organization_category"),
    op: z.enum(["in", "not_in"]),
    values: stringList,
  }),
  z.object({
    field: z.literal("sector_council"),
    op: z.enum(["in", "not_in"]),
    values: uuidList,
  }),
  z.object({
    field: z.literal("event_attendance"),
    op: z.enum(["attended", "not_attended"]),
    values: uuidList,
  }),
  z.object({
    field: z.literal("contact_tag"),
    op: z.enum(["has_any", "has_all", "has_none"]),
    values: stringList,
  }),
  z.object({
    field: z.literal("subscribed"),
    op: z.literal("is"),
    value: z.boolean(),
  }),
  z.object({
    field: z.literal("created"),
    op: z.enum(["before", "after"]),
    value: z.iso.datetime({ offset: true }).or(z.iso.date()),
  }),
  z.object({
    field: z.literal("has_membership"),
    op: z.literal("is"),
    value: z.boolean(),
  }),
]);

/**
 * The rule tree, validated. Depth is capped at 6: a segment nobody can read
 * is a segment nobody can check before it is mailed to three thousand people,
 * and no real WACA list needs more than three levels.
 */
export const audienceRuleSchema: z.ZodType<AudienceRule> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(audienceRuleSchema).max(40) }),
    z.object({ any: z.array(audienceRuleSchema).max(40) }),
    z.object({ not: audienceRuleSchema }),
    conditionSchema,
  ]),
) as z.ZodType<AudienceRule>;

const MAX_RULE_DEPTH = 6;

function assertDepth(rule: AudienceRule, depth = 0): void {
  if (depth > MAX_RULE_DEPTH) {
    throw new Error(
      `audience rule nests deeper than ${MAX_RULE_DEPTH} levels; simplify it`,
    );
  }
  if ("all" in rule) rule.all.forEach((r) => assertDepth(r, depth + 1));
  else if ("any" in rule) rule.any.forEach((r) => assertDepth(r, depth + 1));
  else if ("not" in rule) assertDepth(rule.not, depth + 1);
}

/** Parameterised `in (...)` list. Never string interpolation. */
function list(values: readonly string[]): SQL {
  return sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
}

/**
 * Compile one condition to a predicate over the `contacts` row aliased as
 * `c`. Every value arrives as a bound parameter, so a rule tree -- which is
 * user-authored jsonb -- can never become SQL.
 */
function compileCondition(cond: AudienceCondition): SQL {
  switch (cond.field) {
    case "membership_level": {
      const test = sql`exists (
        select 1 from memberships m
         where m.organization_id = c.organization_id
           and m.is_current
           and m.level_id in (${list(cond.values)}::uuid))`;
      return cond.op === "in" ? test : sql`not ${test}`;
    }
    case "membership_status": {
      const test = sql`exists (
        select 1 from memberships m
         where m.organization_id = c.organization_id
           and m.is_current
           and m.status::text in (${list(cond.values)}))`;
      return cond.op === "in" ? test : sql`not ${test}`;
    }
    case "organization_category": {
      const test = sql`exists (
        select 1 from organizations o
         where o.id = c.organization_id
           and o.archived_at is null
           and o.category::text in (${list(cond.values)}))`;
      return cond.op === "in" ? test : sql`not ${test}`;
    }
    case "sector_council": {
      const test = sql`exists (
        select 1 from council_members cm
         where cm.contact_id = c.id
           and cm.is_active
           and cm.council_id in (${list(cond.values)}::uuid))`;
      return cond.op === "in" ? test : sql`not ${test}`;
    }
    case "event_attendance": {
      // "Attended" means a confirmed registration. A cancelled or waitlisted
      // registration is not attendance, and mailing "thanks for coming" to
      // somebody who cancelled is exactly the sort of thing this table exists
      // to prevent.
      const test = sql`exists (
        select 1 from registrations r
         where r.contact_id = c.id
           and r.status = 'confirmed'
           and r.event_id in (${list(cond.values)}::uuid))`;
      return cond.op === "attended" ? test : sql`not ${test}`;
    }
    case "contact_tag": {
      const arr = sql`array[${list(cond.values)}]::text[]`;
      if (cond.op === "has_any") return sql`(c.tags && ${arr})`;
      if (cond.op === "has_all") return sql`(c.tags @> ${arr})`;
      return sql`(not (c.tags && ${arr}))`;
    }
    case "subscribed":
      return cond.value ? sql`c.email_opt_in` : sql`not c.email_opt_in`;
    case "created":
      return cond.op === "before"
        ? sql`c.created_at < ${cond.value}::timestamptz`
        : sql`c.created_at > ${cond.value}::timestamptz`;
    case "has_membership": {
      const test = sql`exists (
        select 1 from memberships m
         where m.organization_id = c.organization_id
           and m.is_current)`;
      return cond.value ? test : sql`not ${test}`;
    }
  }
}

/** Compile a whole tree. An empty all/any is TRUE/FALSE respectively. */
export function compileAudienceRule(rule: AudienceRule): SQL {
  if ("all" in rule) {
    if (!rule.all.length) return sql`true`;
    return sql`(${sql.join(rule.all.map(compileAudienceRule), sql` and `)})`;
  }
  if ("any" in rule) {
    // An empty `any` matching nobody is the safe default: a half-built
    // segment must not silently mean "everyone".
    if (!rule.any.length) return sql`false`;
    return sql`(${sql.join(rule.any.map(compileAudienceRule), sql` or `)})`;
  }
  if ("not" in rule) return sql`(not ${compileAudienceRule(rule.not)})`;
  return compileCondition(rule);
}

/**
 * BASELINE. Applied to every resolution, on top of whatever the rule says.
 *
 * An archived contact and a blank address are never mailable, whatever a
 * segment claims. This lives here rather than in each audience because a
 * segment author cannot be expected to remember it, and forgetting it once is
 * a bounce campaign.
 */
const RESOLVE_BASELINE = sql`c.archived_at is null and btrim(c.email) <> ''`;

export interface ResolveAudienceOptions extends WithExecutor {
  /**
   * Drop addresses on the global suppression list. Default TRUE.
   * previewAudienceCount() reports both figures so staff can see the gap.
   */
  excludeSuppressed?: boolean;
  /** Cap. Defaults to 50000 — well above WACA's whole contact table. */
  limit?: number;
}

/**
 * THE segmentation predicate. Rule tree in, contact ids out.
 *
 * Validates with `audienceRuleSchema` first: this function is called with
 * jsonb straight out of the database, and a rule row could have been written
 * by an older version of the editor.
 */
export async function resolveAudience(
  rules: AudienceRule,
  opts: ResolveAudienceOptions = {},
): Promise<string[]> {
  const parsed = audienceRuleSchema.parse(rules);
  assertDepth(parsed);
  const database = opts.db ?? defaultDb;
  const predicate = compileAudienceRule(parsed);
  const limit = Math.min(Math.max(opts.limit ?? 50000, 1), 200000);
  const suppressionClause =
    opts.excludeSuppressed === false
      ? sql`true`
      : sql`not exists (select 1 from suppressions s
                         where s.email = lower(btrim(c.email)))`;

  const rows = await database.execute<{ id: string }>(sql`
    select c.id
      from contacts c
     where ${RESOLVE_BASELINE}
       and ${suppressionClause}
       and ${predicate}
     order by c.id
     limit ${limit}
  `);
  return rows.map((r) => r.id);
}

export interface AudiencePreview {
  /** Contacts matching the rule, before the suppression list is applied. */
  matched: number;
  /** How many of those are suppressed and will NOT be mailed. */
  suppressed: number;
  /** matched - suppressed. This is the number that gets an email. */
  mailable: number;
  /** Of the mailable, how many have email_opt_in = false. */
  optedOut: number;
}

/**
 * The figure shown next to a Send button. Reports the gap between "matches
 * the segment" and "will actually receive this", because a composer that only
 * shows the first number teaches staff to expect a send that never happens.
 */
export async function previewAudienceCount(
  rules: AudienceRule,
  opts: WithExecutor = {},
): Promise<AudiencePreview> {
  const parsed = audienceRuleSchema.parse(rules);
  assertDepth(parsed);
  const database = opts.db ?? defaultDb;
  const predicate = compileAudienceRule(parsed);

  const [row] = await database.execute<{
    matched: number;
    suppressed: number;
    opted_out: number;
  }>(sql`
    select
      count(*)::int as matched,
      count(*) filter (
        where exists (select 1 from suppressions s
                       where s.email = lower(btrim(c.email))))::int as suppressed,
      count(*) filter (
        where not c.email_opt_in
          and not exists (select 1 from suppressions s
                           where s.email = lower(btrim(c.email))))::int as opted_out
      from contacts c
     where ${RESOLVE_BASELINE}
       and ${predicate}
  `);

  const matched = Number(row?.matched ?? 0);
  const suppressed = Number(row?.suppressed ?? 0);
  return {
    matched,
    suppressed,
    mailable: matched - suppressed,
    optedOut: Number(row?.opted_out ?? 0),
  };
}

/* ======================================================================
 *  AUDIENCES
 * ==================================================================== */

export interface ListAudiencesParams extends PageParams, WithExecutor {
  search?: string;
  isDynamic?: boolean;
  includeArchived?: boolean;
  sort?: "name" | "updatedAt" | "lastResolvedCount";
  direction?: SortDirection;
}

export interface AudienceListRow {
  id: string;
  name: string;
  description: string | null;
  isDynamic: boolean;
  rules: AudienceRule;
  lastResolvedCount: number | null;
  lastResolvedAt: Date | null;
  snapshotTakenAt: Date | null;
  /** Rows in audience_members. Zero for a dynamic audience. */
  snapshotSize: number;
  /** Campaigns that have used it. */
  campaignCount: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function listAudiences(
  params: ListAudiencesParams = {},
): Promise<Paginated<AudienceListRow>> {
  const database = params.db ?? defaultDb;
  const { page, pageSize, offset } = resolvePaging(params);

  const conditions: SQL[] = [];
  if (!params.includeArchived) conditions.push(isNull(audiences.archivedAt));
  if (params.isDynamic !== undefined)
    conditions.push(eq(audiences.isDynamic, params.isDynamic));
  if (params.search) {
    const q = `%${params.search}%`;
    const c = or(ilike(audiences.name, q), ilike(audiences.description, q));
    if (c) conditions.push(c);
  }
  const where = conditions.length ? and(...conditions)! : sql`true`;

  const sortColumn = {
    name: audiences.name,
    updatedAt: audiences.updatedAt,
    lastResolvedCount: audiences.lastResolvedCount,
  }[params.sort ?? "name"];
  const orderBy =
    params.direction === "desc" ? desc(sortColumn) : asc(sortColumn);

  const rows = await database
    .select({
      id: audiences.id,
      name: audiences.name,
      description: audiences.description,
      isDynamic: audiences.isDynamic,
      rules: audiences.rules,
      lastResolvedCount: audiences.lastResolvedCount,
      lastResolvedAt: audiences.lastResolvedAt,
      snapshotTakenAt: audiences.snapshotTakenAt,
      // Literal identifiers, not Drizzle column references: Drizzle drops the
      // table qualifier inside a raw fragment in the SELECT list, and an
      // unqualified correlated subquery silently returns zero.
      snapshotSize: sql<number>`(select count(*)::int from audience_members am
                                  where am.audience_id = audiences.id)`,
      campaignCount: sql<number>`(select count(*)::int from campaigns cp
                                   where cp.audience_id = audiences.id)`,
      archivedAt: audiences.archivedAt,
      createdAt: audiences.createdAt,
      updatedAt: audiences.updatedAt,
    })
    .from(audiences)
    .where(where)
    .orderBy(orderBy)
    .limit(pageSize)
    .offset(offset);

  const [{ value: total }] = await database
    .select({ value: count() })
    .from(audiences)
    .where(where);

  return paginate(rows as AudienceListRow[], total, page, pageSize);
}

export async function getAudience(
  audienceId: string,
  opts: WithExecutor = {},
): Promise<typeof audiences.$inferSelect | null> {
  const database = opts.db ?? defaultDb;
  const [row] = await database
    .select()
    .from(audiences)
    .where(eq(audiences.id, audienceId))
    .limit(1);
  return row ?? null;
}

/**
 * Resolve an audience BY ID, honouring dynamic vs static.
 *
 *   dynamic -> resolveAudience() against live data
 *   static  -> the frozen audience_members snapshot, minus anyone who has
 *              been suppressed SINCE the snapshot was taken. A snapshot
 *              freezes who was in the segment; it does not and must not
 *              freeze consent.
 */
export async function resolveAudienceById(
  audienceId: string,
  opts: WithExecutor = {},
): Promise<string[]> {
  const database = opts.db ?? defaultDb;
  const audience = await getAudience(audienceId, { db: database });
  if (!audience) throw new Error(`no such audience: ${audienceId}`);

  if (audience.isDynamic) {
    return resolveAudience(audience.rules, { db: database });
  }

  const rows = await database.execute<{ contact_id: string }>(sql`
    select am.contact_id
      from audience_members am
      join contacts c on c.id = am.contact_id
     where am.audience_id = ${audienceId}::uuid
       and c.archived_at is null
       and btrim(c.email) <> ''
       and not exists (select 1 from suppressions s
                        where s.email = lower(btrim(c.email)))
     order by am.contact_id
  `);
  return rows.map((r) => r.contact_id);
}

/**
 * Freeze a static audience's membership. Replaces any previous snapshot.
 * Refuses on a dynamic audience — snapshotting one would produce a second,
 * silently-stale answer to "who is in this segment?".
 */
export async function snapshotAudience(
  audienceId: string,
  opts: WithExecutor = {},
): Promise<{ count: number }> {
  const run = async (tx: DbExecutor) => {
    const audience = await getAudience(audienceId, { db: tx });
    if (!audience) throw new Error(`no such audience: ${audienceId}`);
    if (audience.isDynamic) {
      throw new Error(
        `audience ${audienceId} is dynamic; it resolves at send time and must not be snapshotted`,
      );
    }

    const ids = await resolveAudience(audience.rules, {
      db: tx,
      excludeSuppressed: false,
    });

    await tx
      .delete(audienceMembers)
      .where(eq(audienceMembers.audienceId, audienceId));

    if (ids.length) {
      const people = await tx
        .select({ id: contacts.id, email: contacts.email })
        .from(contacts)
        .where(inArray(contacts.id, ids));
      await tx.insert(audienceMembers).values(
        people.map((p) => ({
          audienceId,
          contactId: p.id,
          email: p.email.trim().toLowerCase(),
        })),
      );
    }

    await tx
      .update(audiences)
      .set({
        snapshotTakenAt: new Date(),
        lastResolvedCount: ids.length,
        lastResolvedAt: new Date(),
      })
      .where(eq(audiences.id, audienceId));

    return { count: ids.length };
  };
  if (opts.db) return run(opts.db);
  return defaultDb.transaction(run);
}

/* ======================================================================
 *  TEMPLATES
 * ==================================================================== */

export interface ListTemplatesParams extends PageParams, WithExecutor {
  category?: EmailCategory;
  search?: string;
  includeArchived?: boolean;
}

export async function listTemplates(
  params: ListTemplatesParams = {},
): Promise<Paginated<typeof emailTemplates.$inferSelect>> {
  const database = params.db ?? defaultDb;
  const { page, pageSize, offset } = resolvePaging(params);
  const conditions: SQL[] = [];
  if (!params.includeArchived)
    conditions.push(isNull(emailTemplates.archivedAt));
  if (params.category)
    conditions.push(eq(emailTemplates.category, params.category));
  if (params.search) {
    const q = `%${params.search}%`;
    const c = or(ilike(emailTemplates.name, q), ilike(emailTemplates.subject, q));
    if (c) conditions.push(c);
  }
  const where = conditions.length ? and(...conditions)! : sql`true`;

  const rows = await database
    .select()
    .from(emailTemplates)
    .where(where)
    .orderBy(asc(emailTemplates.name))
    .limit(pageSize)
    .offset(offset);
  const [{ value: total }] = await database
    .select({ value: count() })
    .from(emailTemplates)
    .where(where);
  return paginate(rows, total, page, pageSize);
}

export async function getTemplate(
  templateId: string,
  opts: WithExecutor = {},
): Promise<typeof emailTemplates.$inferSelect | null> {
  const database = opts.db ?? defaultDb;
  const [row] = await database
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.id, templateId))
    .limit(1);
  return row ?? null;
}

/* ======================================================================
 *  CAMPAIGNS
 * ==================================================================== */

export interface ListCampaignsParams extends PageParams, WithExecutor {
  status?: CampaignStatus | CampaignStatus[];
  category?: EmailCategory;
  audienceId?: string;
  search?: string;
  sort?: "createdAt" | "sentAt" | "name" | "openRate";
  direction?: SortDirection;
}

export interface CampaignListRow {
  id: string;
  name: string;
  subject: string;
  status: CampaignStatus;
  category: EmailCategory;
  audienceId: string | null;
  audienceName: string | null;
  templateId: string | null;
  scheduledAt: Date | null;
  sentAt: Date | null;
  recipientCount: number;
  sentCount: number;
  deliveredCount: number;
  uniqueOpenCount: number;
  uniqueClickCount: number;
  bounceCount: number;
  unsubscribeCount: number;
  /** 0..1, of DELIVERED. Null before anything was delivered. */
  openRate: number | null;
  clickRate: number | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  createdAt: Date;
}

export async function listCampaigns(
  params: ListCampaignsParams = {},
): Promise<Paginated<CampaignListRow>> {
  const database = params.db ?? defaultDb;
  const { page, pageSize, offset } = resolvePaging(params);

  const conditions: SQL[] = [];
  if (params.status) {
    const statuses = Array.isArray(params.status)
      ? params.status
      : [params.status];
    if (statuses.length) conditions.push(inArray(campaigns.status, statuses));
  }
  if (params.category) conditions.push(eq(campaigns.category, params.category));
  if (params.audienceId)
    conditions.push(eq(campaigns.audienceId, params.audienceId));
  if (params.search) {
    const q = `%${params.search}%`;
    const c = or(ilike(campaigns.name, q), ilike(campaigns.subject, q));
    if (c) conditions.push(c);
  }
  const where = conditions.length ? and(...conditions)! : sql`true`;

  // Rates are computed over DELIVERED, not over recipients. Dividing by
  // recipients understates every campaign by its bounce rate and is the
  // number nobody in email marketing means when they say "open rate".
  const openRate = sql<
    number | null
  >`case when ${campaigns.deliveredCount} > 0
        then round(${campaigns.uniqueOpenCount}::numeric / ${campaigns.deliveredCount}, 4)::float8
        else null end`;
  const clickRate = sql<
    number | null
  >`case when ${campaigns.deliveredCount} > 0
        then round(${campaigns.uniqueClickCount}::numeric / ${campaigns.deliveredCount}, 4)::float8
        else null end`;

  const sortColumn = {
    createdAt: campaigns.createdAt,
    sentAt: campaigns.sentAt,
    name: campaigns.name,
    openRate,
  }[params.sort ?? "createdAt"] as SQL | typeof campaigns.createdAt;
  const orderBy =
    params.direction === "asc" ? asc(sortColumn) : desc(sortColumn);

  const rows = await database
    .select({
      id: campaigns.id,
      name: campaigns.name,
      subject: campaigns.subject,
      status: campaigns.status,
      category: campaigns.category,
      audienceId: campaigns.audienceId,
      audienceName: audiences.name,
      templateId: campaigns.templateId,
      scheduledAt: campaigns.scheduledAt,
      sentAt: campaigns.sentAt,
      recipientCount: campaigns.recipientCount,
      sentCount: campaigns.sentCount,
      deliveredCount: campaigns.deliveredCount,
      uniqueOpenCount: campaigns.uniqueOpenCount,
      uniqueClickCount: campaigns.uniqueClickCount,
      bounceCount: campaigns.bounceCount,
      unsubscribeCount: campaigns.unsubscribeCount,
      openRate,
      clickRate,
      approvedBy: campaigns.approvedBy,
      approvedAt: campaigns.approvedAt,
      createdAt: campaigns.createdAt,
    })
    .from(campaigns)
    .leftJoin(audiences, eq(audiences.id, campaigns.audienceId))
    .where(where)
    .orderBy(orderBy)
    .limit(pageSize)
    .offset(offset);

  const [{ value: total }] = await database
    .select({ value: count() })
    .from(campaigns)
    .where(where);

  return paginate(rows as CampaignListRow[], total, page, pageSize);
}

export interface CampaignDetail {
  campaign: typeof campaigns.$inferSelect;
  audience: typeof audiences.$inferSelect | null;
  template: typeof emailTemplates.$inferSelect | null;
  /** Live counts from campaign_recipients, per status. */
  recipientBreakdown: Record<RecipientStatus, number>;
  /**
   * True when everything the send gate requires is present. The composer
   * shows the missing pieces; it does not enable the button and let the
   * database say no.
   */
  readyToSend: boolean;
  blockers: string[];
}

export async function getCampaign(
  campaignId: string,
  opts: WithExecutor = {},
): Promise<CampaignDetail | null> {
  const database = opts.db ?? defaultDb;
  const [campaign] = await database
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!campaign) return null;

  const [audience, template, breakdown] = await Promise.all([
    campaign.audienceId
      ? getAudience(campaign.audienceId, { db: database })
      : Promise.resolve(null),
    campaign.templateId
      ? getTemplate(campaign.templateId, { db: database })
      : Promise.resolve(null),
    database
      .select({ status: campaignRecipients.status, value: count() })
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaignId))
      .groupBy(campaignRecipients.status),
  ]);

  const recipientBreakdown = {
    pending: 0,
    sent: 0,
    delivered: 0,
    opened: 0,
    clicked: 0,
    bounced: 0,
    complained: 0,
    unsubscribed: 0,
    suppressed: 0,
    failed: 0,
  } as Record<RecipientStatus, number>;
  for (const r of breakdown) recipientBreakdown[r.status] = r.value;

  const blockers: string[] = [];
  if (!campaign.audienceId) blockers.push("No audience selected.");
  if (!campaign.textBody.trim())
    blockers.push("No plain-text body. Every WACA email must have one.");
  if (!campaign.subject.trim()) blockers.push("No subject line.");
  if (!campaign.approvedBy || !campaign.approvedAt)
    blockers.push("Not approved by a named person.");
  if (!campaign.sendConfirmationToken)
    blockers.push("No send confirmation has been requested.");
  if (
    campaign.sendConfirmationExpiresAt &&
    campaign.sendConfirmationExpiresAt <= new Date()
  )
    blockers.push("The send confirmation has expired. Approve it again.");
  if (campaign.recipientCount === 0)
    blockers.push("Recipient list has not been built.");

  return {
    campaign,
    audience,
    template,
    recipientBreakdown,
    readyToSend: blockers.length === 0,
    blockers,
  };
}

export interface ListRecipientsParams extends PageParams, WithExecutor {
  status?: RecipientStatus | RecipientStatus[];
  search?: string;
}

export async function listCampaignRecipients(
  campaignId: string,
  params: ListRecipientsParams = {},
): Promise<Paginated<typeof campaignRecipients.$inferSelect>> {
  const database = params.db ?? defaultDb;
  const { page, pageSize, offset } = resolvePaging(params);
  const conditions: SQL[] = [eq(campaignRecipients.campaignId, campaignId)];
  if (params.status) {
    const statuses = Array.isArray(params.status)
      ? params.status
      : [params.status];
    if (statuses.length)
      conditions.push(inArray(campaignRecipients.status, statuses));
  }
  if (params.search)
    conditions.push(ilike(campaignRecipients.email, `%${params.search}%`));
  const where = and(...conditions)!;

  const rows = await database
    .select()
    .from(campaignRecipients)
    .where(where)
    .orderBy(asc(campaignRecipients.email))
    .limit(pageSize)
    .offset(offset);
  const [{ value: total }] = await database
    .select({ value: count() })
    .from(campaignRecipients)
    .where(where);
  return paginate(rows, total, page, pageSize);
}

/* ---------------------------------------------------- buildRecipients */

export const buildRecipientsSchema = z.object({
  campaignId: z.uuid(),
  /** Wipe and rebuild. Default true — a stale list is worse than a slow one. */
  replace: z.boolean().default(true),
});

export type BuildRecipientsInput = z.input<typeof buildRecipientsSchema> & {
  db?: DbExecutor;
};

export interface BuildRecipientsResult {
  campaignId: string;
  /** Contacts the audience resolved to, before suppression. */
  matched: number;
  /** Rows actually written. */
  inserted: number;
  /** Dropped because the address is on the global suppression list. */
  suppressed: number;
  /** Dropped because the address was blank or the contact is archived. */
  unmailable: number;
}

/**
 * Materialise the recipient list for a campaign.
 *
 * THE SUPPRESSION LIST IS APPLIED IN SQL, in the INSERT ... SELECT itself, so
 * a suppressed address is never a row that has to be cleaned up afterwards.
 * The BEFORE INSERT trigger in migration 0006 is the backstop; if it ever
 * fires from this function, something is wrong with this function.
 *
 * Refuses once a campaign has left 'ready'/'draft'/'scheduled'. Rebuilding
 * the list of a send in flight would change who is being mailed halfway
 * through, and nobody could afterwards say who got what.
 */
export async function buildRecipients(
  input: BuildRecipientsInput,
): Promise<BuildRecipientsResult> {
  const parsed = buildRecipientsSchema.parse(input);
  const run = async (tx: DbExecutor): Promise<BuildRecipientsResult> => {
    const [campaign] = await tx
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, parsed.campaignId))
      .limit(1);
    if (!campaign) throw new Error(`no such campaign: ${parsed.campaignId}`);
    if (!["draft", "ready", "scheduled"].includes(campaign.status)) {
      throw new Error(
        `campaign ${campaign.id} is '${campaign.status}'; its recipient list is frozen`,
      );
    }
    if (!campaign.audienceId) {
      throw new Error(`campaign ${campaign.id} has no audience`);
    }

    const contactIds = await resolveAudienceById(campaign.audienceId, {
      db: tx,
    });

    if (parsed.replace) {
      await tx
        .delete(campaignRecipients)
        .where(eq(campaignRecipients.campaignId, parsed.campaignId));
    }

    let inserted = 0;
    let suppressed = 0;
    let unmailable = 0;

    if (contactIds.length) {
      // One statement, chunked only to keep the parameter list sane.
      const CHUNK = 1000;
      for (let i = 0; i < contactIds.length; i += CHUNK) {
        const chunk = contactIds.slice(i, i + CHUNK);
        const rows = await tx.execute<{ id: string }>(sql`
          insert into campaign_recipients (campaign_id, contact_id, email, status)
          select ${parsed.campaignId}::uuid, c.id, lower(btrim(c.email)), 'pending'
            from contacts c
           where c.id in (${list(chunk)}::uuid)
             and c.archived_at is null
             and btrim(c.email) <> ''
             and not exists (select 1 from suppressions s
                              where s.email = lower(btrim(c.email)))
          on conflict (campaign_id, contact_id) do nothing
          returning id
        `);
        inserted += rows.length;
      }

      const [gap] = await tx.execute<{ suppressed: number; unmailable: number }>(sql`
        select
          count(*) filter (
            where exists (select 1 from suppressions s
                           where s.email = lower(btrim(c.email))))::int as suppressed,
          count(*) filter (
            where c.archived_at is not null or btrim(c.email) = '')::int as unmailable
          from contacts c
         where c.id in (${list(contactIds)}::uuid)
      `);
      suppressed = Number(gap?.suppressed ?? 0);
      unmailable = Number(gap?.unmailable ?? 0);
    }

    const [{ value: total }] = await tx
      .select({ value: count() })
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, parsed.campaignId));

    await tx
      .update(campaigns)
      .set({ recipientCount: total, suppressedCount: suppressed })
      .where(eq(campaigns.id, parsed.campaignId));

    return {
      campaignId: parsed.campaignId,
      matched: contactIds.length,
      inserted,
      suppressed,
      unmailable,
    };
  };

  if (input.db) return run(input.db);
  return defaultDb.transaction(run);
}

/* ------------------------------------------------------- the send gate */

export interface ApproveCampaignInput extends WithExecutor {
  campaignId: string;
  /** users.id of the human approving. Never a service account. */
  approvedByUserId: string;
  /** How long the confirmation stays good. Default 30 minutes. */
  ttlMinutes?: number;
  /** The recipient count the approver was shown, for drift detection. */
  approvedRecipientCount: number;
}

export interface ApproveCampaignResult {
  campaignId: string;
  /**
   * THE RAW TOKEN. Returned exactly once, to the approving request. Show it
   * back to the operator (or hold it in the confirm dialog's form state) and
   * pass it to beginCampaignSend(). It is stored on the row, so this is a
   * confirmation handshake and not a secret — its job is to make "send" a
   * deliberate second act, not to authenticate anybody.
   */
  sendConfirmationToken: string;
  expiresAt: Date;
}

/**
 * Step one of two. Records WHO approved and mints a fresh confirmation token.
 * Always mints a new one: re-approving after a change must invalidate the
 * token that was minted for the old version.
 */
export async function approveCampaign(
  input: ApproveCampaignInput,
): Promise<ApproveCampaignResult> {
  const database = input.db ?? defaultDb;
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(
    Date.now() + (input.ttlMinutes ?? 30) * 60 * 1000,
  );

  const updated = await database
    .update(campaigns)
    .set({
      approvedBy: input.approvedByUserId,
      approvedAt: new Date(),
      sendConfirmationToken: token,
      sendConfirmationExpiresAt: expiresAt,
      sendConfirmedAt: null,
      approvedRecipientCount: input.approvedRecipientCount,
    })
    .where(
      and(
        eq(campaigns.id, input.campaignId),
        inArray(campaigns.status, ["draft", "ready", "scheduled"]),
      ),
    )
    .returning({ id: campaigns.id });

  if (!updated.length) {
    throw new Error(
      `campaign ${input.campaignId} cannot be approved in its current state`,
    );
  }
  return { campaignId: input.campaignId, sendConfirmationToken: token, expiresAt };
}

export interface BeginCampaignSendInput extends WithExecutor {
  campaignId: string;
  /** The token from approveCampaign(). */
  sendConfirmationToken: string;
  /**
   * Abort if the recipient count has moved by more than this fraction since
   * approval. Default 0.05. Set to null to skip the check — and be able to
   * explain why.
   */
  maxDrift?: number | null;
}

/**
 * Step two of two. THE ONLY sanctioned way to move a campaign to 'sending'.
 *
 * The token is redeemed in the SAME UPDATE that flips the status, with the
 * token, its expiry and the approval all in the WHERE clause. Zero rows
 * updated therefore means "the confirmation was not valid" and is treated as
 * a refusal to send, not as a retryable error.
 *
 * Beyond that, the CHECK constraint and the trigger in migration 0006 are
 * still there. This function is the front door; they are the locked ones.
 */
export async function beginCampaignSend(
  input: BeginCampaignSendInput,
): Promise<{ campaignId: string; recipientCount: number }> {
  const run = async (tx: DbExecutor) => {
    const [campaign] = await tx
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, input.campaignId))
      .limit(1);
    if (!campaign) throw new Error(`no such campaign: ${input.campaignId}`);

    const drift = input.maxDrift === undefined ? 0.05 : input.maxDrift;
    if (
      drift !== null &&
      campaign.approvedRecipientCount &&
      campaign.approvedRecipientCount > 0
    ) {
      const delta =
        Math.abs(campaign.recipientCount - campaign.approvedRecipientCount) /
        campaign.approvedRecipientCount;
      if (delta > drift) {
        throw new Error(
          `refusing to send campaign ${campaign.id}: the recipient list has moved from ` +
            `${campaign.approvedRecipientCount} to ${campaign.recipientCount} since it was ` +
            `approved. Re-approve it so a human sees the new number.`,
        );
      }
    }

    const now = new Date();
    const updated = await tx
      .update(campaigns)
      .set({ status: "sending", sendConfirmedAt: now })
      .where(
        and(
          eq(campaigns.id, input.campaignId),
          inArray(campaigns.status, ["ready", "scheduled"]),
          eq(campaigns.sendConfirmationToken, input.sendConfirmationToken),
          isNull(campaigns.sendConfirmedAt),
          sql`${campaigns.approvedBy} is not null`,
          sql`${campaigns.approvedAt} is not null`,
          sql`(${campaigns.sendConfirmationExpiresAt} is null
               or ${campaigns.sendConfirmationExpiresAt} > now())`,
        ),
      )
      .returning({
        id: campaigns.id,
        recipientCount: campaigns.recipientCount,
      });

    if (!updated.length) {
      throw new Error(
        `refusing to send campaign ${input.campaignId}: no valid, unexpired, unredeemed ` +
          `send confirmation from a named approver. Approve it again.`,
      );
    }
    return {
      campaignId: updated[0].id,
      recipientCount: updated[0].recipientCount,
    };
  };

  if (input.db) return run(input.db);
  return defaultDb.transaction(run);
}

/* ======================================================================
 *  SUPPRESSIONS
 * ==================================================================== */

export interface ListSuppressionsParams extends PageParams, WithExecutor {
  reason?: SuppressionReason | SuppressionReason[];
  search?: string;
  source?: string;
  sort?: "createdAt" | "email";
  direction?: SortDirection;
}

export interface SuppressionRow {
  id: string;
  email: string;
  reason: SuppressionReason;
  source: string;
  campaignId: string | null;
  contactId: string | null;
  detail: string | null;
  notes: string | null;
  createdAt: Date;
  /** Name of the contact, when the address matches one. */
  contactName: string | null;
}

export async function listSuppressions(
  params: ListSuppressionsParams = {},
): Promise<Paginated<SuppressionRow>> {
  const database = params.db ?? defaultDb;
  const { page, pageSize, offset } = resolvePaging(params);

  const conditions: SQL[] = [];
  if (params.reason) {
    const reasons = Array.isArray(params.reason)
      ? params.reason
      : [params.reason];
    if (reasons.length) conditions.push(inArray(suppressions.reason, reasons));
  }
  if (params.source) conditions.push(eq(suppressions.source, params.source));
  if (params.search)
    conditions.push(ilike(suppressions.email, `%${params.search.trim().toLowerCase()}%`));
  const where = conditions.length ? and(...conditions)! : sql`true`;

  const sortColumn =
    params.sort === "email" ? suppressions.email : suppressions.createdAt;
  const orderBy =
    params.direction === "asc" ? asc(sortColumn) : desc(sortColumn);

  const rows = await database
    .select({
      id: suppressions.id,
      email: suppressions.email,
      reason: suppressions.reason,
      source: suppressions.source,
      campaignId: suppressions.campaignId,
      contactId: suppressions.contactId,
      detail: suppressions.detail,
      notes: suppressions.notes,
      createdAt: suppressions.createdAt,
      contactName: contacts.displayName,
    })
    .from(suppressions)
    .leftJoin(contacts, eq(contacts.id, suppressions.contactId))
    .where(where)
    .orderBy(orderBy)
    .limit(pageSize)
    .offset(offset);

  const [{ value: total }] = await database
    .select({ value: count() })
    .from(suppressions)
    .where(where);

  return paginate(rows as SuppressionRow[], total, page, pageSize);
}

export const suppressSchema = z.object({
  email: z.string().trim().max(320).pipe(z.email()),
  reason: z.enum(["unsubscribed", "bounced", "complained", "manual"]),
  source: z.string().trim().min(1).max(120).default("admin"),
  campaignId: z.uuid().nullish(),
  contactId: z.uuid().nullish(),
  detail: z.string().trim().max(1000).nullish(),
  notes: z.string().trim().max(1000).nullish(),
  createdBy: z.uuid().nullish(),
});

export type SuppressInput = z.input<typeof suppressSchema> & {
  db?: DbExecutor;
};

/**
 * Add an address to the global suppression list. IDEMPOTENT: suppressing an
 * already-suppressed address returns the existing row rather than raising,
 * because every caller of this is a webhook or a link click that will be
 * delivered more than once.
 *
 * The address is normalised by trigger on the way in; passing mixed case or
 * surrounding whitespace is safe.
 */
export async function suppress(
  input: SuppressInput,
): Promise<typeof suppressions.$inferSelect> {
  const parsed = suppressSchema.parse(input);
  const database = input.db ?? defaultDb;
  const email = parsed.email.trim().toLowerCase();

  const [row] = await database
    .insert(suppressions)
    .values({
      email,
      reason: parsed.reason,
      source: parsed.source,
      campaignId: parsed.campaignId ?? null,
      contactId: parsed.contactId ?? null,
      detail: parsed.detail ?? null,
      notes: parsed.notes ?? null,
      createdBy: parsed.createdBy ?? null,
    })
    .onConflictDoNothing({ target: suppressions.email })
    .returning();

  if (row) return row;

  const [existing] = await database
    .select()
    .from(suppressions)
    .where(eq(suppressions.email, email))
    .limit(1);
  return existing;
}

/**
 * THE check. One definition, mirroring `public.is_suppressed()` in SQL, which
 * the campaign_recipients trigger uses. The two must agree.
 */
export async function isSuppressed(
  email: string,
  opts: WithExecutor = {},
): Promise<boolean> {
  const database = opts.db ?? defaultDb;
  const [row] = await database.execute<{ suppressed: boolean }>(
    sql`select public.is_suppressed(${email}) as suppressed`,
  );
  return Boolean(row?.suppressed);
}

/** Batch form, for a send worker that has a page of addresses in hand. */
export async function filterSuppressed(
  emails: string[],
  opts: WithExecutor = {},
): Promise<Set<string>> {
  if (!emails.length) return new Set();
  const database = opts.db ?? defaultDb;
  const normalised = emails.map((e) => e.trim().toLowerCase());
  const rows = await database
    .select({ email: suppressions.email })
    .from(suppressions)
    .where(inArray(suppressions.email, normalised));
  return new Set(rows.map((r) => r.email));
}

/* ======================================================================
 *  UNSUBSCRIBE TOKENS -- the unauthenticated path
 * ==================================================================== */

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface IssueUnsubscribeTokenInput extends WithExecutor {
  contactId: string;
  scope?: "all" | "category";
  /** Required when scope is 'category'. */
  category?: EmailCategory | null;
  campaignId?: string | null;
  /** Null (default) = never expires. See the schema comment for why. */
  expiresAt?: Date | null;
}

/**
 * Mint one unsubscribe link's token. Returns the RAW token — the only time it
 * exists outside the email. Put it in the URL; the database keeps the hash.
 */
export async function issueUnsubscribeToken(
  input: IssueUnsubscribeTokenInput,
): Promise<{ token: string; id: string }> {
  const database = input.db ?? defaultDb;
  const scope = input.scope ?? "all";
  if (scope === "category" && !input.category) {
    throw new Error("a category-scoped unsubscribe token needs a category");
  }
  // 32 bytes = 256 bits. Not guessable, not enumerable.
  const token = randomBytes(32).toString("base64url");
  const [row] = await database
    .insert(unsubscribeTokens)
    .values({
      contactId: input.contactId,
      tokenHash: hashToken(token),
      scope,
      category: scope === "category" ? input.category! : null,
      campaignId: input.campaignId ?? null,
      expiresAt: input.expiresAt ?? null,
    })
    .returning({ id: unsubscribeTokens.id });
  return { token, id: row.id };
}

export interface UnsubscribePeek {
  valid: boolean;
  scope: "all" | "category" | null;
  category: EmailCategory | null;
  /** j••••@e••••.org. Never the real address. */
  maskedEmail: string | null;
  alreadyUsed: boolean;
}

/**
 * READ-ONLY. Safe to call from a GET, which matters: corporate link scanners
 * pre-fetch every URL in an email, and a GET that unsubscribed people would
 * empty WACA's list by itself.
 *
 * Delegates to `public.peek_unsubscribe_token()` so the anonymous route and
 * the signed-in one run the same code, and so the raw token is hashed inside
 * the database rather than at three different call sites.
 */
export async function peekUnsubscribeToken(
  token: string,
  opts: WithExecutor = {},
): Promise<UnsubscribePeek> {
  const database = opts.db ?? defaultDb;
  const [row] = await database.execute<{
    valid: boolean;
    scope: "all" | "category" | null;
    category: EmailCategory | null;
    masked_email: string | null;
    already_used: boolean;
  }>(sql`select * from public.peek_unsubscribe_token(${token})`);
  return {
    valid: Boolean(row?.valid),
    scope: row?.scope ?? null,
    category: row?.category ?? null,
    maskedEmail: row?.masked_email ?? null,
    alreadyUsed: Boolean(row?.already_used),
  };
}

export interface UnsubscribeResult {
  ok: boolean;
  scope: "all" | "category" | null;
  category: EmailCategory | null;
  maskedEmail: string | null;
}

/**
 * WRITE. Call from a POST only.
 *
 * Claims the token, adds the address to the suppression list, flips
 * email_opt_in for a global unsubscribe, and marks the recipient row so the
 * campaign's unsubscribe count is real. Idempotent: a double submit returns
 * the same success.
 *
 * Never returns the contact id or the unmasked address, so the response to an
 * anonymous request discloses nothing about who the token belonged to.
 */
export async function redeemUnsubscribeToken(
  token: string,
  opts: WithExecutor = {},
): Promise<UnsubscribeResult> {
  const database = opts.db ?? defaultDb;
  const [row] = await database.execute<{
    ok: boolean;
    scope: "all" | "category" | null;
    category: EmailCategory | null;
    masked_email: string | null;
  }>(sql`select * from public.redeem_unsubscribe_token(${token})`);
  return {
    ok: Boolean(row?.ok),
    scope: row?.scope ?? null,
    category: row?.category ?? null,
    maskedEmail: row?.masked_email ?? null,
  };
}

/* ======================================================================
 *  DASHBOARD
 * ==================================================================== */

export interface EmailCounts {
  audiences: number;
  templates: number;
  campaignsByStatus: Record<CampaignStatus, number>;
  suppressions: number;
  suppressionsByReason: Record<SuppressionReason, number>;
  /** Mean unique-open rate across sent campaigns, 0..1. */
  averageOpenRate: number | null;
  lastSentAt: Date | null;
}

export async function getEmailCounts(
  opts: WithExecutor = {},
): Promise<EmailCounts> {
  const database = opts.db ?? defaultDb;

  const [audienceCount, templateCount, suppressionCount] = await Promise.all([
    database
      .select({ value: count() })
      .from(audiences)
      .where(isNull(audiences.archivedAt))
      .then((r) => r[0]?.value ?? 0),
    database
      .select({ value: count() })
      .from(emailTemplates)
      .where(isNull(emailTemplates.archivedAt))
      .then((r) => r[0]?.value ?? 0),
    database
      .select({ value: count() })
      .from(suppressions)
      .then((r) => r[0]?.value ?? 0),
  ]);

  const statusRows = await database
    .select({ status: campaigns.status, value: count() })
    .from(campaigns)
    .groupBy(campaigns.status);

  const reasonRows = await database
    .select({ reason: suppressions.reason, value: count() })
    .from(suppressions)
    .groupBy(suppressions.reason);

  const [agg] = await database.execute<{
    avg_open: number | null;
    last_sent: Date | null;
  }>(sql`
    select
      avg(unique_open_count::numeric / nullif(delivered_count, 0))::float8 as avg_open,
      max(sent_at) as last_sent
      from campaigns
     where status = 'sent' and delivered_count > 0
  `);

  const campaignsByStatus = {
    draft: 0,
    ready: 0,
    scheduled: 0,
    sending: 0,
    sent: 0,
    paused: 0,
    cancelled: 0,
    failed: 0,
  } as Record<CampaignStatus, number>;
  for (const r of statusRows) campaignsByStatus[r.status] = r.value;

  const suppressionsByReason = {
    unsubscribed: 0,
    bounced: 0,
    complained: 0,
    manual: 0,
  } as Record<SuppressionReason, number>;
  for (const r of reasonRows) suppressionsByReason[r.reason] = r.value;

  return {
    audiences: audienceCount,
    templates: templateCount,
    campaignsByStatus,
    suppressions: suppressionCount,
    suppressionsByReason,
    averageOpenRate: agg?.avg_open ?? null,
    lastSentAt: agg?.last_sent ? new Date(agg.last_sent) : null,
  };
}

/* ======================================================================
 *  ADDED BY THE EMAIL TOOL — the numbers a human is shown before a send.
 *
 *  These extend the helpers above rather than living in the composer,
 *  because the sentence on the review page ("3,246 contacts -> 3,180 after
 *  suppressions -> 3,174 after bounces") has to be computed by the SAME
 *  predicate as the list that is actually mailed. A composer that assembles
 *  that sentence from its own SQL is a composer whose headline can disagree
 *  with its own send.
 * ==================================================================== */

/** The suppression list, split by why each address is on it. */
export interface AudienceDeductions extends AudiencePreview {
  /** Of `suppressed`: hard/soft bounces recorded by the provider. */
  bounced: number;
  /** Of `suppressed`: people who used an unsubscribe link. */
  unsubscribed: number;
  /** Of `suppressed`: spam complaints. */
  complained: number;
  /** Of `suppressed`: added by hand on /admin/email/suppressions. */
  manual: number;
}

const EMPTY_DEDUCTIONS: AudienceDeductions = {
  matched: 0,
  suppressed: 0,
  mailable: 0,
  optedOut: 0,
  bounced: 0,
  unsubscribed: 0,
  complained: 0,
  manual: 0,
};

/**
 * The deduction breakdown for a saved audience, honouring dynamic vs static
 * exactly as `resolveAudienceById()` does — so the numbers on the review page
 * describe the list `buildRecipients()` will actually produce.
 */
export async function previewAudienceDeductions(
  audienceId: string,
  opts: WithExecutor = {},
): Promise<AudienceDeductions> {
  const database = opts.db ?? defaultDb;
  const audience = await getAudience(audienceId, { db: database });
  if (!audience) return EMPTY_DEDUCTIONS;

  // The candidate set, BEFORE suppression, under whichever resolution mode
  // this audience uses.
  const candidates = audience.isDynamic
    ? sql`select c.id, c.email, c.email_opt_in
            from contacts c
           where ${RESOLVE_BASELINE}
             and ${compileAudienceRule(audienceRuleSchema.parse(audience.rules))}`
    : sql`select c.id, c.email, c.email_opt_in
            from audience_members am
            join contacts c on c.id = am.contact_id
           where am.audience_id = ${audienceId}::uuid
             and ${RESOLVE_BASELINE}`;

  const [row] = await database.execute<{
    matched: number;
    suppressed: number;
    opted_out: number;
    bounced: number;
    unsubscribed: number;
    complained: number;
    manual: number;
  }>(sql`
    with candidate as (${candidates}),
         joined as (
           select cd.email_opt_in,
                  s.reason::text as reason
             from candidate cd
             left join suppressions s on s.email = lower(btrim(cd.email))
         )
    select
      count(*)::int                                            as matched,
      count(*) filter (where reason is not null)::int          as suppressed,
      count(*) filter (where reason is null and not email_opt_in)::int as opted_out,
      count(*) filter (where reason = 'bounced')::int          as bounced,
      count(*) filter (where reason = 'unsubscribed')::int     as unsubscribed,
      count(*) filter (where reason = 'complained')::int       as complained,
      count(*) filter (where reason = 'manual')::int           as manual
      from joined
  `);

  const matched = Number(row?.matched ?? 0);
  const suppressed = Number(row?.suppressed ?? 0);
  return {
    matched,
    suppressed,
    mailable: matched - suppressed,
    optedOut: Number(row?.opted_out ?? 0),
    bounced: Number(row?.bounced ?? 0),
    unsubscribed: Number(row?.unsubscribed ?? 0),
    complained: Number(row?.complained ?? 0),
    manual: Number(row?.manual ?? 0),
  };
}

/* ------------------------------------------------------ segment sample */

/**
 * A row in the segment builder's live preview, and — not by coincidence — the
 * exact shape a merge field reads. The people you are shown while building a
 * segment are the people whose data would be merged into the message, drawn
 * by the same predicate. A preview that used a different query would be a
 * preview you could not trust.
 */
export interface AudienceSampleRow {
  contactId: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  email: string;
  title: string | null;
  organizationName: string | null;
  organizationCategory: string | null;
  membershipLevel: string | null;
  membershipStatus: string | null;
  renewalDate: Date | null;
  memberSince: Date | null;
  councils: string[];
  emailOptIn: boolean;
  suppressedReason: SuppressionReason | null;
}

export interface SampleAudienceParams extends WithExecutor {
  /** Default 20 — the number the segment builder shows. */
  limit?: number;
  /** Include people the suppression list would drop, flagged. Default true,
   *  because "who is excluded and why" is the question staff actually have. */
  includeSuppressed?: boolean;
}

async function sampleFromPredicate(
  predicate: SQL,
  params: SampleAudienceParams,
): Promise<AudienceSampleRow[]> {
  const database = params.db ?? defaultDb;
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 200);
  const suppressionClause =
    params.includeSuppressed === false
      ? sql`and not exists (select 1 from suppressions s2
                             where s2.email = lower(btrim(c.email)))`
      : sql``;

  const rows = await database.execute<{
    contact_id: string;
    first_name: string | null;
    last_name: string | null;
    display_name: string | null;
    email: string;
    title: string | null;
    organization_name: string | null;
    organization_category: string | null;
    membership_level: string | null;
    membership_status: string | null;
    renewal_date: Date | null;
    member_since: Date | null;
    councils: string[] | null;
    email_opt_in: boolean;
    suppressed_reason: SuppressionReason | null;
  }>(sql`
    select
      c.id                as contact_id,
      c.first_name, c.last_name, c.display_name, c.email, c.title,
      c.email_opt_in,
      o.display_name      as organization_name,
      o.category::text    as organization_category,
      o.member_since,
      ml.name             as membership_level,
      m.status::text      as membership_status,
      m.expires_on        as renewal_date,
      (select coalesce(array_agg(cl.name order by cl.sort_order), '{}')
         from council_members cm
         join councils cl on cl.id = cm.council_id
        where cm.contact_id = c.id and cm.is_active) as councils,
      (select s.reason::text from suppressions s
        where s.email = lower(btrim(c.email))) as suppressed_reason
      from contacts c
      left join organizations o on o.id = c.organization_id
      left join memberships m on m.organization_id = c.organization_id and m.is_current
      left join membership_levels ml on ml.id = m.level_id
     where ${RESOLVE_BASELINE}
       ${suppressionClause}
       and ${predicate}
     order by c.display_name
     limit ${limit}
  `);

  return rows.map((r) => ({
    contactId: r.contact_id,
    firstName: r.first_name,
    lastName: r.last_name,
    displayName: r.display_name,
    email: r.email,
    title: r.title,
    organizationName: r.organization_name,
    organizationCategory: r.organization_category,
    membershipLevel: r.membership_level,
    membershipStatus: r.membership_status,
    renewalDate: r.renewal_date ? new Date(r.renewal_date) : null,
    memberSince: r.member_since ? new Date(r.member_since) : null,
    councils: r.councils ?? [],
    emailOptIn: Boolean(r.email_opt_in),
    suppressedReason: r.suppressed_reason ?? null,
  }));
}

/** Sample rows for an UNSAVED rule tree — what the segment builder shows as
 *  the rules change. */
export async function sampleAudience(
  rules: AudienceRule,
  params: SampleAudienceParams = {},
): Promise<AudienceSampleRow[]> {
  const parsed = audienceRuleSchema.parse(rules);
  assertDepth(parsed);
  return sampleFromPredicate(compileAudienceRule(parsed), params);
}

/** Sample rows for a saved audience, honouring dynamic vs static. */
export async function sampleAudienceById(
  audienceId: string,
  params: SampleAudienceParams = {},
): Promise<AudienceSampleRow[]> {
  const database = params.db ?? defaultDb;
  const audience = await getAudience(audienceId, { db: database });
  if (!audience) return [];
  if (audience.isDynamic) {
    return sampleAudience(audience.rules, params);
  }
  return sampleFromPredicate(
    sql`exists (select 1 from audience_members am
                 where am.audience_id = ${audienceId}::uuid
                   and am.contact_id = c.id)`,
    params,
  );
}

/** One contact's merge data, for the "send a test to myself" preview. */
export async function getMergeSubject(
  contactId: string,
  opts: WithExecutor = {},
): Promise<AudienceSampleRow | null> {
  const rows = await sampleFromPredicate(sql`c.id = ${contactId}::uuid`, {
    ...opts,
    limit: 1,
  });
  return rows[0] ?? null;
}

/* -------------------------------------------------------- list health */

/**
 * HOW MANY PEOPLE CAN WACA ACTUALLY REACH?
 *
 * The headline on /admin/email. Not "how many contacts are in the database" —
 * that number is 3,246 and it is the number that makes an association think
 * its list is healthy. The number that matters is how many of those are
 * subscribed, not suppressed, and have not bounced.
 */
export interface ListHealth {
  /** Every live contact with an address. */
  contacts: number;
  /** Of those, how many have email_opt_in. */
  subscribed: number;
  /** Of those, how many are on the suppression list at all. */
  suppressed: number;
  bounced: number;
  unsubscribed: number;
  complained: number;
  manual: number;
  /** subscribed AND not suppressed. THE number. */
  reachable: number;
  /** Live contacts whose organisation holds a current membership. */
  members: number;
  /** reachable, minus the members. WACA's membership pipeline. */
  reachableNonMembers: number;
  /** Suppression rows whose address matches no live contact. */
  orphanSuppressions: number;
}

export async function getListHealth(
  opts: WithExecutor = {},
): Promise<ListHealth> {
  const database = opts.db ?? defaultDb;

  const [row] = await database.execute<Record<string, number>>(sql`
    with live as (
      select c.id,
             c.email_opt_in,
             lower(btrim(c.email)) as email,
             exists (select 1 from memberships m
                      where m.organization_id = c.organization_id
                        and m.is_current) as is_member
        from contacts c
       where c.archived_at is null and btrim(c.email) <> ''
    ),
    joined as (
      select live.*, s.reason::text as reason
        from live
        left join suppressions s on s.email = live.email
    )
    select
      count(*)::int                                                  as contacts,
      count(*) filter (where email_opt_in)::int                      as subscribed,
      count(*) filter (where reason is not null)::int                as suppressed,
      count(*) filter (where reason = 'bounced')::int                as bounced,
      count(*) filter (where reason = 'unsubscribed')::int           as unsubscribed,
      count(*) filter (where reason = 'complained')::int             as complained,
      count(*) filter (where reason = 'manual')::int                 as manual,
      count(*) filter (where email_opt_in and reason is null)::int   as reachable,
      count(*) filter (where is_member)::int                         as members,
      count(*) filter (where email_opt_in and reason is null and not is_member)::int
                                                                     as reachable_non_members,
      (select count(*)::int from suppressions s2
        where not exists (select 1 from live l2 where l2.email = s2.email))
                                                                     as orphan_suppressions
      from joined
  `);

  const n = (k: string) => Number(row?.[k] ?? 0);
  return {
    contacts: n("contacts"),
    subscribed: n("subscribed"),
    suppressed: n("suppressed"),
    bounced: n("bounced"),
    unsubscribed: n("unsubscribed"),
    complained: n("complained"),
    manual: n("manual"),
    reachable: n("reachable"),
    members: n("members"),
    reachableNonMembers: n("reachable_non_members"),
    orphanSuppressions: n("orphan_suppressions"),
  };
}
