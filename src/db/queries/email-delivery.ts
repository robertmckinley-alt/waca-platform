import { sql, type SQL } from "drizzle-orm";
import { db as defaultDb, type DbExecutor } from "@/db";

/**
 * ============================================================================
 *  DELIVERY QUERIES — the SQL half of the send pipeline.
 *
 *  Kept apart from `email.ts` (which is the composer's contract: audiences,
 *  campaigns, approval, suppression, tokens) because everything in here is
 *  about a send that is ALREADY UNDERWAY: claiming work, recording an
 *  outcome, folding a provider event back into a recipient row.
 *
 *  Nothing here can start a send. There is no function below that moves a
 *  campaign into 'sending' — that is `beginCampaignSend()` in email.ts and
 *  the CHECK constraint plus trigger in migration 0006, and it needs a named
 *  human approver and a live confirmation token. These helpers only ever run
 *  after that has happened.
 *
 *  WHY THE SQL LIVES HERE AND NOT IN src/lib/email: the house rule. Query
 *  helpers are shared and reviewable in one place; a module that hand-rolls
 *  its own SQL is a module whose access rules eventually disagree with
 *  everybody else's.
 * ============================================================================
 */

export interface WithDb {
  db?: DbExecutor;
}

/* ======================================================================
 *  1. CLAIMING WORK
 * ==================================================================== */

export interface ClaimedRecipient {
  recipientId: string;
  contactId: string;
  email: string;
  /** Non-null when this row is being RE-claimed after a crashed run. */
  previouslyClaimedAt: Date | null;
}

export interface ClaimRecipientsInput extends WithDb {
  campaignId: string;
  limit: number;
  /**
   * How long a claim is honoured before another run may take the row back.
   * See the comment on the function.
   */
  leaseMs?: number;
}

/**
 * CLAIM A BATCH, ATOMICALLY.
 *
 * The queue is `campaign_recipients WHERE status = 'pending'`, and a claim is
 * `sent_at IS NOT NULL` while the status is still 'pending'. That gives three
 * states out of two existing columns, with no schema change and no lying:
 *
 *      status='pending', sent_at NULL      queued, nobody has touched it
 *      status='pending', sent_at set       claimed, in flight (or crashed)
 *      status='sent',    sent_at set       handed to the provider, confirmed
 *
 * `FOR UPDATE SKIP LOCKED` means two workers racing the same campaign take
 * disjoint batches rather than fighting or double-sending. The row lock is
 * held only for the length of this statement — never across the HTTP call to
 * the provider, which is the mistake that turns a slow provider into a
 * database-wide stall.
 *
 * THE LEASE. A run that dies mid-batch leaves rows claimed for ever unless
 * something reclaims them. After `leaseMs` (10 minutes by default) they come
 * back into the queue, so a crashed send resumes by itself. Re-sending a row
 * whose first attempt may or may not have reached Resend is safe because
 * every message carries a DETERMINISTIC idempotency key derived from
 * (campaign, recipient) — Resend collapses the duplicate rather than
 * delivering it twice.
 */
export async function claimPendingRecipients(
  input: ClaimRecipientsInput,
): Promise<ClaimedRecipient[]> {
  const database = input.db ?? defaultDb;
  const leaseSeconds = Math.max(30, Math.round((input.leaseMs ?? 600_000) / 1000));
  const limit = Math.min(Math.max(input.limit, 1), 500);

  const rows = await database.execute<{
    id: string;
    contact_id: string;
    email: string;
    previous_sent_at: Date | null;
  }>(sql`
    update campaign_recipients cr
       set sent_at = now()
      from (
        select r.id, r.sent_at as previous_sent_at
          from campaign_recipients r
         where r.campaign_id = ${input.campaignId}::uuid
           and r.status = 'pending'
           and (r.sent_at is null
                or r.sent_at < now() - make_interval(secs => ${leaseSeconds}))
         order by r.email
           for update skip locked
         limit ${limit}
      ) claimed
     where cr.id = claimed.id
    returning cr.id, cr.contact_id, cr.email, claimed.previous_sent_at
  `);

  return rows.map((r) => ({
    recipientId: r.id,
    contactId: r.contact_id,
    email: r.email,
    previouslyClaimedAt: r.previous_sent_at ? new Date(r.previous_sent_at) : null,
  }));
}

/* ======================================================================
 *  2. RECORDING AN OUTCOME
 * ==================================================================== */

/** The message reached the provider. This is the only place status becomes
 *  'sent', and it always carries the id the provider gave us (or, in a dry
 *  run, a `dry-run:` id that says plainly that nothing was transmitted). */
export async function markRecipientSent(input: {
  recipientId: string;
  providerMessageId: string | null;
  db?: DbExecutor;
}): Promise<void> {
  const database = input.db ?? defaultDb;
  await database.execute(sql`
    update campaign_recipients
       set status = 'sent',
           provider_message_id = ${input.providerMessageId},
           error = null,
           sent_at = coalesce(sent_at, now())
     where id = ${input.recipientId}::uuid
       and status = 'pending'
  `);
}

/** The provider refused it, or refused it five times. Terminal until a human
 *  requeues it — an automatic retry loop against a permanent error is how a
 *  sender earns a rate-limit ban. */
export async function markRecipientFailed(input: {
  recipientId: string;
  error: string;
  db?: DbExecutor;
}): Promise<void> {
  const database = input.db ?? defaultDb;
  await database.execute(sql`
    update campaign_recipients
       set status = 'failed',
           error = ${input.error.slice(0, 1000)},
           sent_at = null
     where id = ${input.recipientId}::uuid
       and status = 'pending'
  `);
}

/**
 * The address must not be written to after all — it went onto the suppression
 * list, or its contact was archived, or a duplicate of it in this same
 * campaign has already been sent. The claim is released and the row is closed
 * out with the reason, so "why did 41 people not get this?" has an answer on
 * the report instead of in somebody's memory.
 */
export async function markRecipientSuppressed(input: {
  recipientId: string;
  reason: string;
  db?: DbExecutor;
}): Promise<void> {
  const database = input.db ?? defaultDb;
  await database.execute(sql`
    update campaign_recipients
       set status = 'suppressed',
           error = ${input.reason.slice(0, 1000)},
           sent_at = null
     where id = ${input.recipientId}::uuid
       and status = 'pending'
  `);
}

/**
 * DEDUPE BY ADDRESS.
 *
 * `campaign_recipients` is unique on (campaign, CONTACT) — two contact records
 * sharing one mailbox are two rows, and without this both would receive the
 * message. Addresses are already lower-cased and trimmed by trigger, so this
 * is a straight partition by `email`.
 *
 * The keeper is the earliest row; the rest are closed as 'suppressed' with the
 * reason on the row. Idempotent, so it can run at the top of every dispatch
 * pass including a resumed one.
 */
export async function dedupeRecipientsByEmail(
  campaignId: string,
  opts: WithDb = {},
): Promise<number> {
  const database = opts.db ?? defaultDb;
  const rows = await database.execute<{ id: string }>(sql`
    with ranked as (
      select id,
             row_number() over (partition by email order by created_at, id) as rn
        from campaign_recipients
       where campaign_id = ${campaignId}::uuid
         and status = 'pending'
    )
    update campaign_recipients cr
       set status = 'suppressed',
           error = 'Duplicate address in this campaign — the message went to the first contact holding it.'
      from ranked
     where ranked.id = cr.id
       and ranked.rn > 1
    returning cr.id
  `);
  return rows.length;
}

/** Put failed rows — or rows claimed by a run that never came back — into the
 *  queue again. Explicit, human-initiated, and safe: the provider's
 *  idempotency key means a row that WAS delivered will not be delivered
 *  twice. */
export async function requeueRecipients(input: {
  campaignId: string;
  which: "failed" | "unconfirmed";
  olderThanMs?: number;
  db?: DbExecutor;
}): Promise<number> {
  const database = input.db ?? defaultDb;
  const seconds = Math.max(60, Math.round((input.olderThanMs ?? 900_000) / 1000));

  const predicate: SQL =
    input.which === "failed"
      ? sql`status = 'failed'`
      : sql`status = 'pending' and sent_at is not null
            and sent_at < now() - make_interval(secs => ${seconds})`;

  const rows = await database.execute<{ id: string }>(sql`
    update campaign_recipients
       set status = 'pending', sent_at = null, error = null
     where campaign_id = ${input.campaignId}::uuid
       and ${predicate}
    returning id
  `);
  return rows.length;
}

/* ======================================================================
 *  3. PROGRESS AND STATISTICS
 * ==================================================================== */

export interface SendProgress {
  total: number;
  /** Not yet claimed. */
  queued: number;
  /** Claimed, outcome not yet recorded. */
  inFlight: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
  suppressed: number;
  failed: number;
  /** queued + inFlight — what a resumed run would still have to do. */
  remaining: number;
}

export async function campaignSendProgress(
  campaignId: string,
  opts: WithDb = {},
): Promise<SendProgress> {
  const database = opts.db ?? defaultDb;
  const [row] = await database.execute<Record<string, number>>(sql`
    select
      count(*)::int                                                    as total,
      count(*) filter (where status = 'pending' and sent_at is null)::int     as queued,
      count(*) filter (where status = 'pending' and sent_at is not null)::int as in_flight,
      count(*) filter (where status = 'sent')::int                     as sent,
      count(*) filter (where status = 'delivered')::int                as delivered,
      count(*) filter (where status = 'opened')::int                   as opened,
      count(*) filter (where status = 'clicked')::int                  as clicked,
      count(*) filter (where status = 'bounced')::int                  as bounced,
      count(*) filter (where status = 'complained')::int               as complained,
      count(*) filter (where status = 'unsubscribed')::int             as unsubscribed,
      count(*) filter (where status = 'suppressed')::int               as suppressed,
      count(*) filter (where status = 'failed')::int                   as failed
      from campaign_recipients
     where campaign_id = ${campaignId}::uuid
  `);
  const n = (k: string) => Number(row?.[k] ?? 0);
  return {
    total: n("total"),
    queued: n("queued"),
    inFlight: n("in_flight"),
    sent: n("sent"),
    delivered: n("delivered"),
    opened: n("opened"),
    clicked: n("clicked"),
    bounced: n("bounced"),
    complained: n("complained"),
    unsubscribed: n("unsubscribed"),
    suppressed: n("suppressed"),
    failed: n("failed"),
    remaining: n("queued") + n("in_flight"),
  };
}

/**
 * RECOMPUTE the denormalised counters on `campaigns` FROM the recipient rows.
 *
 * Recomputed rather than incremented, every time, deliberately. An increment
 * that runs twice (a retried webhook, a resumed send) is silently wrong for
 * ever, and the number WACA quotes to a sponsor is its open rate. A full
 * recount over a few thousand rows costs nothing and cannot drift.
 *
 * `suppressed_count` is NOT touched: it is owned by buildRecipients() and
 * means "addresses the audience matched that the list excluded before the
 * send", which is a different question from "recipients closed as suppressed
 * during the send".
 */
export async function recomputeCampaignStats(
  campaignId: string,
  opts: WithDb = {},
): Promise<void> {
  const database = opts.db ?? defaultDb;
  await database.execute(sql`
    with s as (
      select
        count(*)::int                                              as recipients,
        count(*) filter (where status not in ('pending','suppressed','failed'))::int as sent,
        count(*) filter (where delivered_at is not null)::int       as delivered,
        count(*) filter (where first_opened_at is not null)::int    as opens,
        count(*) filter (where first_clicked_at is not null)::int   as clicks,
        count(*) filter (where status = 'bounced')::int             as bounced,
        count(*) filter (where status = 'complained')::int          as complained,
        count(*) filter (where status = 'unsubscribed')::int        as unsubscribed,
        count(*) filter (where status = 'failed')::int              as failed
        from campaign_recipients
       where campaign_id = ${campaignId}::uuid
    )
    update campaigns c
       set recipient_count    = s.recipients,
           sent_count         = s.sent,
           delivered_count    = s.delivered,
           unique_open_count  = s.opens,
           unique_click_count = s.clicks,
           bounce_count       = s.bounced,
           complaint_count    = s.complained,
           unsubscribe_count  = s.unsubscribed,
           failed_count       = s.failed
      from s
     where c.id = ${campaignId}::uuid
  `);
}

/* ======================================================================
 *  4. PROVIDER EVENTS
 * ==================================================================== */

export interface RecordEmailEventInput extends WithDb {
  provider?: string;
  /** The provider's own event id. THE dedupe key. */
  providerEventId: string;
  eventType: string;
  providerMessageId?: string | null;
  email?: string | null;
  occurredAt: Date;
  payload: Record<string, unknown>;
}

export interface RecordEmailEventResult {
  eventId: string | null;
  /** True when this exact event has already been recorded and folded in. */
  duplicate: boolean;
  campaignId: string | null;
  recipientId: string | null;
  contactId: string | null;
  email: string | null;
}

/**
 * Record one webhook event, exactly once.
 *
 * The unique index on (provider, provider_event_id) is the dedupe, and
 * `ON CONFLICT DO NOTHING` is how we notice: zero rows returned means the
 * provider retried, and the caller must not fold the same open into the
 * count twice. Providers retry on any non-2xx, and an inflated open rate is
 * a number WACA would put in front of a sponsor.
 *
 * The event is joined to its recipient by `provider_message_id` — the id this
 * application stored when it handed the message over. An event we cannot
 * match (a transactional message, or one sent before this table existed) is
 * still recorded, with null campaign and recipient, because an unmatched
 * bounce is still a bounce and still has to reach the suppression list.
 */
export async function recordEmailEvent(
  input: RecordEmailEventInput,
): Promise<RecordEmailEventResult> {
  const database = input.db ?? defaultDb;
  const provider = input.provider ?? "resend";
  const email = input.email ? input.email.trim().toLowerCase() : null;

  const rows = await database.execute<{
    id: string;
    campaign_id: string | null;
    recipient_id: string | null;
    contact_id: string | null;
    email: string | null;
  }>(sql`
    with matched as (
      select cr.id as recipient_id, cr.campaign_id, cr.contact_id, cr.email
        from campaign_recipients cr
       where cr.provider_message_id = ${input.providerMessageId ?? null}
       limit 1
    )
    insert into email_events (
      provider, provider_event_id, event_type, provider_message_id,
      campaign_id, recipient_id, contact_id, email, payload, occurred_at,
      processed_at
    )
    select ${provider}, ${input.providerEventId}, ${input.eventType},
           ${input.providerMessageId ?? null},
           m.campaign_id, m.recipient_id, m.contact_id,
           coalesce(${email}, m.email),
           ${JSON.stringify(input.payload)}::jsonb,
           ${input.occurredAt.toISOString()}::timestamptz,
           null
      from (select 1) one
      left join matched m on true
    on conflict (provider, provider_event_id) do nothing
    returning id, campaign_id, recipient_id, contact_id, email
  `);

  if (!rows.length) {
    return {
      eventId: null,
      duplicate: true,
      campaignId: null,
      recipientId: null,
      contactId: null,
      email,
    };
  }
  const row = rows[0];
  return {
    eventId: row.id,
    duplicate: false,
    campaignId: row.campaign_id,
    recipientId: row.recipient_id,
    contactId: row.contact_id,
    email: row.email,
  };
}

/** Mark an event as folded into the recipient row (or record why it was not). */
export async function markEmailEventProcessed(input: {
  eventId: string;
  error?: string | null;
  db?: DbExecutor;
}): Promise<void> {
  const database = input.db ?? defaultDb;
  await database.execute(sql`
    update email_events
       set processed_at = now(),
           processing_error = ${input.error ?? null}
     where id = ${input.eventId}::uuid
  `);
}

export type RecipientOutcome =
  | "delivered"
  | "opened"
  | "clicked"
  | "bounced"
  | "complained"
  | "unsubscribed"
  | "failed";

/**
 * Fold one event into its recipient row, in ONE statement.
 *
 * TWO RULES, both of which exist because events arrive out of order — every
 * provider's webhooks do, and Resend's are no exception:
 *
 *   1. STATUS ONLY EVER MOVES FORWARD, by the ranking below. A 'delivered'
 *      that arrives after an 'opened' must not un-open the message, and an
 *      'opened' that arrives after a 'complained' must not un-complain it.
 *   2. FIRST TIMESTAMPS ARE `coalesce`d, never overwritten. `first_opened_at`
 *      is the field an open rate is computed from; a retried webhook must not
 *      move it.
 *
 * Open and click COUNTS do increment — they are meant to count every load —
 * but only from an event that was not a duplicate, which recordEmailEvent()
 * has already decided.
 */
export async function applyRecipientOutcome(input: {
  recipientId: string;
  outcome: RecipientOutcome;
  occurredAt: Date;
  error?: string | null;
  db?: DbExecutor;
}): Promise<void> {
  const database = input.db ?? defaultDb;
  const at = input.occurredAt.toISOString();
  const outcome = input.outcome;

  const rank = (expr: SQL) => sql`
    case ${expr}
      when 'pending'      then 0
      when 'suppressed'   then 1
      when 'sent'         then 2
      when 'delivered'    then 3
      when 'opened'       then 4
      when 'clicked'      then 5
      when 'failed'       then 6
      when 'unsubscribed' then 7
      when 'bounced'      then 8
      when 'complained'   then 9
      else 0
    end`;

  await database.execute(sql`
    update campaign_recipients
       set status = case
             when ${rank(sql`status::text`)} < ${rank(sql`${outcome}::text`)}
             then ${outcome}::campaign_recipient_status
             else status
           end,
           delivered_at = case when ${outcome}::text in ('delivered','opened','clicked')
                               then coalesce(delivered_at, ${at}::timestamptz)
                               else delivered_at end,
           first_opened_at = case when ${outcome}::text in ('opened','clicked')
                                  then coalesce(first_opened_at, ${at}::timestamptz)
                                  else first_opened_at end,
           last_opened_at = case when ${outcome}::text = 'opened'
                                 then ${at}::timestamptz else last_opened_at end,
           first_clicked_at = case when ${outcome}::text = 'clicked'
                                   then coalesce(first_clicked_at, ${at}::timestamptz)
                                   else first_clicked_at end,
           open_count = open_count + case when ${outcome}::text = 'opened' then 1 else 0 end,
           click_count = click_count + case when ${outcome}::text = 'clicked' then 1 else 0 end,
           error = coalesce(${input.error ?? null}, error)
     where id = ${input.recipientId}::uuid
  `);
}

/* ======================================================================
 *  5. THE SCHEDULED-SEND QUEUE
 * ==================================================================== */

export interface DispatchableCampaign {
  campaignId: string;
  name: string;
  status: "scheduled" | "sending";
  scheduledAt: Date | null;
  /** Present only when the row carries a complete human approval. */
  sendConfirmationToken: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  sendConfirmedAt: Date | null;
  sendConfirmationExpiresAt: Date | null;
  recipientCount: number;
  pendingCount: number;
}

/**
 * WHAT THE SCHEDULED WORKER IS ALLOWED TO LOOK AT.
 *
 * Two, and only two, kinds of row:
 *
 *   status='scheduled' AND scheduled_at <= now()   a send a human approved and
 *                                                  timed. The approval fields
 *                                                  are returned so the caller
 *                                                  re-verifies them; this
 *                                                  query does not decide.
 *   status='sending'                               a run already under way,
 *                                                  which crashed or ran out
 *                                                  of clock. Resuming it is
 *                                                  not a new send.
 *
 * A draft, a 'ready', a paused or a cancelled campaign is never returned. The
 * worker therefore has no path to starting something nobody approved, and
 * that is a property of this query rather than of the caller's discipline.
 */
export async function listDispatchableCampaigns(
  opts: WithDb & { now?: Date; limit?: number } = {},
): Promise<DispatchableCampaign[]> {
  const database = opts.db ?? defaultDb;
  const now = (opts.now ?? new Date()).toISOString();

  const rows = await database.execute<{
    id: string;
    name: string;
    status: "scheduled" | "sending";
    scheduled_at: Date | null;
    send_confirmation_token: string | null;
    approved_by: string | null;
    approved_at: Date | null;
    send_confirmed_at: Date | null;
    send_confirmation_expires_at: Date | null;
    recipient_count: number;
    pending_count: number;
  }>(sql`
    select c.id, c.name, c.status::text as status, c.scheduled_at,
           c.send_confirmation_token, c.approved_by, c.approved_at,
           c.send_confirmed_at, c.send_confirmation_expires_at,
           c.recipient_count,
           (select count(*)::int from campaign_recipients r
             where r.campaign_id = c.id and r.status = 'pending') as pending_count
      from campaigns c
     where (c.status = 'sending')
        or (c.status = 'scheduled' and c.scheduled_at is not null
            and c.scheduled_at <= ${now}::timestamptz)
     order by c.scheduled_at nulls first, c.created_at
     limit ${Math.min(Math.max(opts.limit ?? 20, 1), 100)}
  `);

  return rows.map((r) => ({
    campaignId: r.id,
    name: r.name,
    status: r.status,
    scheduledAt: r.scheduled_at ? new Date(r.scheduled_at) : null,
    sendConfirmationToken: r.send_confirmation_token,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at ? new Date(r.approved_at) : null,
    sendConfirmedAt: r.send_confirmed_at ? new Date(r.send_confirmed_at) : null,
    sendConfirmationExpiresAt: r.send_confirmation_expires_at
      ? new Date(r.send_confirmation_expires_at)
      : null,
    recipientCount: Number(r.recipient_count ?? 0),
    pendingCount: Number(r.pending_count ?? 0),
  }));
}

/** Close a finished run. 'sending' -> 'sent' is the only legal exit and the
 *  trigger in 0006 enforces it; `sent_at` is required by CHECK. */
export async function markCampaignSent(
  campaignId: string,
  opts: WithDb & { at?: Date } = {},
): Promise<boolean> {
  const database = opts.db ?? defaultDb;
  const rows = await database.execute<{ id: string }>(sql`
    update campaigns
       set status = 'sent', sent_at = ${(opts.at ?? new Date()).toISOString()}::timestamptz
     where id = ${campaignId}::uuid
       and status = 'sending'
    returning id
  `);
  return rows.length > 0;
}

/* ======================================================================
 *  6. THE UNSUBSCRIBE UNDO
 * ==================================================================== */

export interface UndoUnsubscribeResult {
  ok: boolean;
  /** j••••@e••••.org, never the real address. */
  maskedEmail: string | null;
  reason?: "not-found" | "not-unsubscribed" | "window-expired";
}

/**
 * PUT IT BACK — the "undo" on the unsubscribe confirmation page.
 *
 * Hashes the token IN THE DATABASE, with the same `digest(token,'sha256')`
 * that `peek_unsubscribe_token()` and `redeem_unsubscribe_token()` use in
 * migration 0007, so the three can never disagree about what a token is.
 *
 * BOUNDED BY TIME. Only a token redeemed within the window may be undone.
 * Without that, a token sitting in an old mailbox would be a permanent
 * re-subscribe button for an address whose owner asked to be left alone — the
 * one failure mode an unsubscribe mechanism absolutely may not have.
 *
 * Reveals nothing: every failure returns the same flat shape, and success
 * returns a masked address the holder of the link already knew.
 *
 * Unlike peek/redeem this is NOT exposed to the `anon` role. It is called
 * only by this application's own server route, which connects as the owning
 * database role; there is no Supabase-client path to it and it needs no
 * SECURITY DEFINER wrapper.
 */
export async function undoUnsubscribeToken(
  token: string,
  opts: WithDb & { windowMinutes?: number } = {},
): Promise<UndoUnsubscribeResult> {
  const database = opts.db ?? defaultDb;
  const windowMinutes = Math.max(1, Math.min(opts.windowMinutes ?? 60, 24 * 60));

  if (!token || token.length < 32) {
    return { ok: false, maskedEmail: null, reason: "not-found" };
  }

  const run = async (tx: DbExecutor): Promise<UndoUnsubscribeResult> => {
    const [tok] = await tx.execute<{
      id: string;
      contact_id: string;
      campaign_id: string | null;
      used_at: Date | null;
      email: string;
      masked: string;
    }>(sql`
      select t.id, t.contact_id, t.campaign_id, t.used_at,
             lower(btrim(c.email)) as email,
             public.mask_email(c.email) as masked
        from public.unsubscribe_tokens t
        join public.contacts c on c.id = t.contact_id
       where t.token_hash = encode(digest(${token}, 'sha256'), 'hex')
       limit 1
    `);

    if (!tok) return { ok: false, maskedEmail: null, reason: "not-found" };
    if (!tok.used_at) {
      return { ok: false, maskedEmail: null, reason: "not-unsubscribed" };
    }

    const usedAt = new Date(tok.used_at).getTime();
    if (Date.now() - usedAt > windowMinutes * 60 * 1000) {
      return { ok: false, maskedEmail: null, reason: "window-expired" };
    }

    // 1. Off the suppression list — but ONLY the row this link created. A
    //    hard bounce or a spam complaint for the same address is a different
    //    fact about the world and an undo must not clear it.
    await tx.execute(sql`
      delete from public.suppressions
       where email = ${tok.email}
         and reason = 'unsubscribed'
         and source like 'unsubscribe-link%'
    `);

    // 2. Opt-in back on, so segment counts tell the truth again.
    await tx.execute(sql`
      update public.contacts
         set email_opt_in = true, updated_at = now()
       where id = ${tok.contact_id}::uuid
    `);

    // 3. The token is spent either way: an undo does not hand back a working
    //    unsubscribe link, it just reverses what this one did. Marking it
    //    undone rather than unused keeps the audit honest.
    await tx.execute(sql`
      update public.unsubscribe_tokens
         set used_at = now()
       where id = ${tok.id}::uuid
    `);

    // 4. The campaign's unsubscribe count follows the recipient row.
    if (tok.campaign_id) {
      await tx.execute(sql`
        update public.campaign_recipients
           set status = 'sent'
         where campaign_id = ${tok.campaign_id}::uuid
           and contact_id = ${tok.contact_id}::uuid
           and status = 'unsubscribed'
      `);
    }

    return { ok: true, maskedEmail: tok.masked };
  };

  if (opts.db) return run(opts.db);
  return defaultDb.transaction(run);
}

/* ======================================================================
 *  7. THE TRANSACTIONAL / MARKETING DISTINCTION
 * ==================================================================== */

export type SuppressionBlock = "hard-bounce" | "complaint" | "manual" | null;

/**
 * WHY A TRANSACTIONAL MESSAGE ASKS A DIFFERENT QUESTION.
 *
 * A campaign asks "is this address suppressed?" and the answer is yes or no.
 * An invoice has to ask a sharper question, because the four reasons an
 * address lands on that list are not the same kind of fact:
 *
 *   'unsubscribed'  A PREFERENCE about marketing. It says nothing about the
 *                   invoice this organisation owes, or the event they just
 *                   registered for. Leaving a newsletter must not stop a
 *                   member receiving their own bill — that would be a worse
 *                   outcome for them than for WACA. -> NOT a block.
 *
 *   'bounced'       A FACT about the mailbox: it does not exist. Written only
 *                   for a PERMANENT bounce (see webhooks.ts). Sending again
 *                   cannot succeed, and every attempt is another hard bounce
 *                   counted against the sending domain. -> BLOCK.
 *
 *   'complained'    A FACT about the recipient: they pressed "this is spam".
 *                   Continuing to mail a complainant is the single fastest
 *                   way to move a domain into the junk folder for everybody
 *                   else on it, and no invoice is worth that. -> BLOCK, and
 *                   the invoice goes out by post or by phone.
 *
 *   'manual'        A HUMAN INSTRUCTION from WACA staff: do not write to this
 *                   address. -> BLOCK. If it was a mistake, the fix is to
 *                   remove the suppression on /admin/email/suppressions,
 *                   which is audited — not an override flag on a send.
 *
 * Returns null when the address is clear, or when it is only suppressed for
 * a reason transactional mail is entitled to ignore.
 */
export async function transactionalBlock(
  email: string,
  opts: WithDb = {},
): Promise<SuppressionBlock> {
  const database = opts.db ?? defaultDb;
  const address = (email ?? "").trim().toLowerCase();
  if (!address) return null;

  const [row] = await database.execute<{ reason: string }>(sql`
    select reason::text as reason
      from suppressions
     where email = ${address}
     limit 1
  `);
  if (!row) return null;
  switch (row.reason) {
    case "bounced":
      return "hard-bounce";
    case "complained":
      return "complaint";
    case "manual":
      return "manual";
    case "unsubscribed":
    default:
      return null;
  }
}
