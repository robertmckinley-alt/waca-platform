-- ===========================================================================
-- 0006  CONTENT + EMAIL.
--
-- Tables generated from src/db/schema/{content,email}.ts, followed by the
-- hand-written half that Drizzle cannot express and that carries most of the
-- safety in this migration:
--
--   * the circular FK content_items.published_revision_id -> content_revisions
--   * gap-free per-item revision numbering
--   * alt text REQUIRED on images, by CHECK
--   * a campaign that cannot reach 'sending' without a named human approver
--     and a live, single-use confirmation token, by CHECK and by trigger
--   * a global suppression list enforced at INSERT on campaign_recipients
--   * address normalisation, so no caller has to remember to lower-case
--
-- RLS for these tables is migration 0007. Replays unchanged against Supabase.
-- ===========================================================================

CREATE TYPE "public"."campaign_recipient_status" AS ENUM('pending', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained', 'unsubscribed', 'suppressed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'ready', 'scheduled', 'sending', 'sent', 'paused', 'cancelled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."content_publish_status" AS ENUM('queued', 'dispatched', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."content_status" AS ENUM('draft', 'in_review', 'scheduled', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."content_type_key" AS ENUM('page', 'press', 'record', 'agenda', 'post', 'person', 'member', 'stat', 'nav', 'setting');--> statement-breakpoint
CREATE TYPE "public"."email_category" AS ENUM('newsletter', 'policy-alert', 'event', 'membership', 'council', 'fundraising', 'general');--> statement-breakpoint
CREATE TYPE "public"."suppression_reason" AS ENUM('unsubscribed', 'bounced', 'complained', 'manual');--> statement-breakpoint
CREATE TYPE "public"."unsubscribe_scope" AS ENUM('all', 'category');--> statement-breakpoint
CREATE TABLE "content_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"alt_text" text,
	"is_decorative" boolean DEFAULT false NOT NULL,
	"credit" text,
	"ai_generated" boolean DEFAULT false NOT NULL,
	"ai_note" text,
	"long_description" text,
	"uploaded_by" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "content_type_key" NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"locale" text DEFAULT 'en-US' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"publish_at" timestamp with time zone,
	"unpublish_at" timestamp with time zone,
	"published_revision_id" uuid,
	"published_at" timestamp with time zone,
	"excerpt" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_publishes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "content_publish_status" DEFAULT 'queued' NOT NULL,
	"item_ids" uuid[] DEFAULT '{}' NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"triggered_by" uuid,
	"triggered_by_label" text,
	"note" text,
	"deploy_hook_status" integer,
	"deploy_hook_response" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deployment_id" text,
	"deployment_url" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "content_revision_sequences" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"excerpt" text,
	"summary" text,
	"author_user_id" uuid,
	"author_label" text,
	"restored_from_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" "content_type_key" NOT NULL,
	"label" text NOT NULL,
	"label_plural" text NOT NULL,
	"description" text,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"route_pattern" text,
	"astro_target" text,
	"is_singleton" boolean DEFAULT false NOT NULL,
	"allows_create" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_types_key_uq" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "audience_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audience_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"email" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audiences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"rules" jsonb DEFAULT '{"all":[]}'::jsonb NOT NULL,
	"is_dynamic" boolean DEFAULT true NOT NULL,
	"snapshot_taken_at" timestamp with time zone,
	"last_resolved_count" integer,
	"last_resolved_at" timestamp with time zone,
	"created_by" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"email" text NOT NULL,
	"status" "campaign_recipient_status" DEFAULT 'pending' NOT NULL,
	"provider_message_id" text,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"first_opened_at" timestamp with time zone,
	"last_opened_at" timestamp with time zone,
	"first_clicked_at" timestamp with time zone,
	"open_count" integer DEFAULT 0 NOT NULL,
	"click_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"template_id" uuid,
	"audience_id" uuid,
	"subject" text NOT NULL,
	"preheader" text,
	"from_name" text NOT NULL,
	"from_email" text NOT NULL,
	"reply_to" text,
	"category" "email_category" DEFAULT 'newsletter' NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"html_body" text DEFAULT '' NOT NULL,
	"text_body" text DEFAULT '' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"send_confirmation_token" text,
	"send_confirmation_expires_at" timestamp with time zone,
	"send_confirmed_at" timestamp with time zone,
	"approved_recipient_count" integer,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"delivered_count" integer DEFAULT 0 NOT NULL,
	"unique_open_count" integer DEFAULT 0 NOT NULL,
	"unique_click_count" integer DEFAULT 0 NOT NULL,
	"bounce_count" integer DEFAULT 0 NOT NULL,
	"complaint_count" integer DEFAULT 0 NOT NULL,
	"unsubscribe_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"suppressed_count" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text DEFAULT 'resend' NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"provider_message_id" text,
	"campaign_id" uuid,
	"recipient_id" uuid,
	"contact_id" uuid,
	"email" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_error" text
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"subject" text NOT NULL,
	"preheader" text,
	"blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"text_body" text NOT NULL,
	"category" "email_category" DEFAULT 'newsletter' NOT NULL,
	"created_by" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"reason" "suppression_reason" NOT NULL,
	"source" text DEFAULT 'admin' NOT NULL,
	"campaign_id" uuid,
	"contact_id" uuid,
	"detail" text,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unsubscribe_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"scope" "unsubscribe_scope" DEFAULT 'all' NOT NULL,
	"category" "email_category",
	"campaign_id" uuid,
	"expires_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_assets" ADD CONSTRAINT "content_assets_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_type_content_types_key_fk" FOREIGN KEY ("type") REFERENCES "public"."content_types"("key") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_publishes" ADD CONSTRAINT "content_publishes_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_revision_sequences" ADD CONSTRAINT "content_revision_sequences_item_id_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_item_id_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audience_members" ADD CONSTRAINT "audience_members_audience_id_audiences_id_fk" FOREIGN KEY ("audience_id") REFERENCES "public"."audiences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audience_members" ADD CONSTRAINT "audience_members_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audiences" ADD CONSTRAINT "audiences_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_template_id_email_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."email_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_audience_id_audiences_id_fk" FOREIGN KEY ("audience_id") REFERENCES "public"."audiences"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_recipient_id_campaign_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."campaign_recipients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unsubscribe_tokens" ADD CONSTRAINT "unsubscribe_tokens_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unsubscribe_tokens" ADD CONSTRAINT "unsubscribe_tokens_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_assets_key_uq" ON "content_assets" USING btree ("key");--> statement-breakpoint
CREATE INDEX "content_assets_mime_idx" ON "content_assets" USING btree ("mime");--> statement-breakpoint
CREATE INDEX "content_assets_created_at_idx" ON "content_assets" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "content_assets_ai_generated_idx" ON "content_assets" USING btree ("ai_generated");--> statement-breakpoint
CREATE INDEX "content_assets_filename_trgm_idx" ON "content_assets" USING gin ("filename" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "content_items_type_slug_locale_uq" ON "content_items" USING btree ("type","slug","locale");--> statement-breakpoint
CREATE INDEX "content_items_type_status_publish_at_idx" ON "content_items" USING btree ("type","status","publish_at");--> statement-breakpoint
CREATE INDEX "content_items_status_idx" ON "content_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "content_items_published_revision_idx" ON "content_items" USING btree ("published_revision_id");--> statement-breakpoint
CREATE INDEX "content_items_updated_at_idx" ON "content_items" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "content_items_data_gin_idx" ON "content_items" USING gin ("data" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "content_items_title_trgm_idx" ON "content_items" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "content_publishes_started_at_idx" ON "content_publishes" USING btree ("started_at" desc);--> statement-breakpoint
CREATE INDEX "content_publishes_status_idx" ON "content_publishes" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "content_publishes_triggered_by_idx" ON "content_publishes" USING btree ("triggered_by");--> statement-breakpoint
CREATE UNIQUE INDEX "content_revisions_item_number_uq" ON "content_revisions" USING btree ("item_id","revision_number");--> statement-breakpoint
CREATE INDEX "content_revisions_item_number_desc_idx" ON "content_revisions" USING btree ("item_id","revision_number" desc);--> statement-breakpoint
CREATE INDEX "content_revisions_author_idx" ON "content_revisions" USING btree ("author_user_id");--> statement-breakpoint
CREATE INDEX "content_types_sort_idx" ON "content_types" USING btree ("sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "audience_members_audience_contact_uq" ON "audience_members" USING btree ("audience_id","contact_id");--> statement-breakpoint
CREATE INDEX "audience_members_audience_idx" ON "audience_members" USING btree ("audience_id");--> statement-breakpoint
CREATE INDEX "audience_members_contact_idx" ON "audience_members" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "audiences_name_uq" ON "audiences" USING btree ("name");--> statement-breakpoint
CREATE INDEX "audiences_archived_at_idx" ON "audiences" USING btree ("archived_at");--> statement-breakpoint
CREATE INDEX "audiences_is_dynamic_idx" ON "audiences" USING btree ("is_dynamic");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_recipients_campaign_contact_uq" ON "campaign_recipients" USING btree ("campaign_id","contact_id");--> statement-breakpoint
CREATE INDEX "campaign_recipients_campaign_status_idx" ON "campaign_recipients" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "campaign_recipients_provider_message_id_idx" ON "campaign_recipients" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "campaign_recipients_contact_idx" ON "campaign_recipients" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "campaign_recipients_email_idx" ON "campaign_recipients" USING btree ("email");--> statement-breakpoint
CREATE INDEX "campaigns_status_idx" ON "campaigns" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "campaigns_audience_idx" ON "campaigns" USING btree ("audience_id");--> statement-breakpoint
CREATE INDEX "campaigns_template_idx" ON "campaigns" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "campaigns_sent_at_idx" ON "campaigns" USING btree ("sent_at" desc);--> statement-breakpoint
CREATE INDEX "campaigns_category_idx" ON "campaigns" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_send_confirmation_token_uq" ON "campaigns" USING btree ("send_confirmation_token") WHERE send_confirmation_token is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "email_events_provider_event_id_uq" ON "email_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "email_events_campaign_occurred_idx" ON "email_events" USING btree ("campaign_id","occurred_at");--> statement-breakpoint
CREATE INDEX "email_events_provider_message_id_idx" ON "email_events" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "email_events_unprocessed_idx" ON "email_events" USING btree ("received_at") WHERE processed_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "email_templates_name_uq" ON "email_templates" USING btree ("name");--> statement-breakpoint
CREATE INDEX "email_templates_category_idx" ON "email_templates" USING btree ("category");--> statement-breakpoint
CREATE INDEX "email_templates_archived_at_idx" ON "email_templates" USING btree ("archived_at");--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_email_uq" ON "suppressions" USING btree ("email");--> statement-breakpoint
CREATE INDEX "suppressions_reason_idx" ON "suppressions" USING btree ("reason","created_at");--> statement-breakpoint
CREATE INDEX "suppressions_contact_idx" ON "suppressions" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "suppressions_created_at_idx" ON "suppressions" USING btree ("created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "unsubscribe_tokens_token_hash_uq" ON "unsubscribe_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "unsubscribe_tokens_contact_idx" ON "unsubscribe_tokens" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "unsubscribe_tokens_campaign_idx" ON "unsubscribe_tokens" USING btree ("campaign_id");
--> statement-breakpoint
-- ###########################################################################
-- #  HAND-WRITTEN HALF                                                      #
-- ###########################################################################

-- ---------------------------------------------------------------------------
-- 1. THE CIRCULAR FK.
--
-- content_items.published_revision_id points at the revision that is LIVE on
-- the public site, and content_revisions.item_id points back. Drizzle cannot
-- express the cycle, exactly as with users <-> contacts in 0001.
--
-- ON DELETE SET NULL rather than CASCADE: revisions are append-only and are
-- never deleted in normal operation, but if one ever is, losing the pointer
-- must not take the item with it.
-- ---------------------------------------------------------------------------
ALTER TABLE "content_items"
  ADD CONSTRAINT "content_items_published_revision_id_fk"
  FOREIGN KEY ("published_revision_id")
  REFERENCES "public"."content_revisions"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint

ALTER TABLE "content_revisions"
  ADD CONSTRAINT "content_revisions_restored_from_revision_id_fk"
  FOREIGN KEY ("restored_from_revision_id")
  REFERENCES "public"."content_revisions"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. CONTENT ITEM INTEGRITY.
-- ---------------------------------------------------------------------------

-- A published item ALWAYS names the exact revision that is live. Without this
-- "what is on the site right now?" would have two possible answers -- the
-- item's working data and the last revision -- and they would drift the first
-- time somebody saved a draft on a published page.
ALTER TABLE "content_items"
  ADD CONSTRAINT "content_items_published_needs_revision"
  CHECK (status <> 'published' OR published_revision_id IS NOT NULL);--> statement-breakpoint

-- Scheduled means scheduled FOR something.
ALTER TABLE "content_items"
  ADD CONSTRAINT "content_items_scheduled_needs_publish_at"
  CHECK (status <> 'scheduled' OR publish_at IS NOT NULL);--> statement-breakpoint

ALTER TABLE "content_items"
  ADD CONSTRAINT "content_items_unpublish_after_publish"
  CHECK (unpublish_at IS NULL OR publish_at IS NULL OR unpublish_at > publish_at);--> statement-breakpoint

-- Slugs become public URLs. Lower-case, hyphen-separated, no leading or
-- trailing hyphen -- validated here and not only in Zod, because the importer
-- and the seed also write this column.
ALTER TABLE "content_items"
  ADD CONSTRAINT "content_items_slug_format"
  CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$');--> statement-breakpoint

ALTER TABLE "content_revisions"
  ADD CONSTRAINT "content_revisions_number_positive"
  CHECK (revision_number >= 1);--> statement-breakpoint

-- Partial index for the scheduled-publish sweep: "anything due to go live or
-- come down". Tiny, because almost nothing is ever scheduled.
CREATE INDEX IF NOT EXISTS "content_items_due_publish_idx"
  ON "content_items" ("publish_at")
  WHERE status = 'scheduled' AND publish_at IS NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "content_items_due_unpublish_idx"
  ON "content_items" ("unpublish_at")
  WHERE status = 'published' AND unpublish_at IS NOT NULL;--> statement-breakpoint

-- The snapshot the public build fetches: published items of a type, in order.
CREATE INDEX IF NOT EXISTS "content_items_api_snapshot_idx"
  ON "content_items" ("type", "sort_order", "slug")
  WHERE status = 'published';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. GAP-FREE REVISION NUMBERS.
--
-- Same technique as next_invoice_number() in 0004, and for the same reason: a
-- Postgres sequence keeps its increment through a rollback, and a hole in a
-- numbered history reads as a deleted revision to whoever audits it. Call this
-- INSIDE the transaction that inserts the revision.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.next_content_revision_number(p_item_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_number integer;
BEGIN
  -- Self-seed from whatever is already on the table for this item, so an
  -- imported history or a hand-written INSERT cannot be overwritten.
  INSERT INTO content_revision_sequences (item_id, last_number)
  SELECT p_item_id, coalesce(max(revision_number), 0)
    FROM content_revisions
   WHERE item_id = p_item_id
  ON CONFLICT (item_id) DO NOTHING;

  LOOP
    -- UPDATE ... RETURNING row-locks the counter: two concurrent savers queue
    -- here and cannot be handed the same number.
    UPDATE content_revision_sequences
       SET last_number = last_number + 1,
           updated_at  = now()
     WHERE item_id = p_item_id
    RETURNING last_number INTO v_number;

    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM content_revisions
       WHERE item_id = p_item_id AND revision_number = v_number
    );
  END LOOP;

  RETURN v_number;
END;
$fn$;--> statement-breakpoint

COMMENT ON FUNCTION public.next_content_revision_number(uuid) IS
  'Allocates the next gap-free revision number for a content item. Call INSIDE the transaction that inserts the revision.';--> statement-breakpoint

COMMENT ON TABLE "content_revisions" IS
  'APPEND-ONLY history. Every save is a revision. Restoring an old version writes a NEW revision whose data is a copy and whose restored_from_revision_id says so -- history is never mutated and never deleted.';--> statement-breakpoint

COMMENT ON COLUMN "content_items"."data" IS
  'The WORKING copy the editor edits. NOT what the public build reads -- that is content_revisions.data for published_revision_id.';--> statement-breakpoint

COMMENT ON COLUMN "content_items"."published_revision_id" IS
  'The revision that is LIVE at /api/content/*. A published item may not have this null (CHECK content_items_published_needs_revision).';--> statement-breakpoint

COMMENT ON TABLE "content_publishes" IS
  'Audit of publish runs. The Vercel deploy hook URL is a credential and is NEVER stored here -- only the HTTP status it returned, its response body, and the resulting deployment URL.';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. ALT TEXT IS NOT OPTIONAL.
--
-- The public site refuses to publish audio without a transcript and holds zero
-- axe violations at WCAG 2.1 AA. None of that survives a CMS that lets staff
-- drop an unlabelled image onto the home page. So: an image asset either
-- carries alt text, or it is DECLARED decorative and carries none (rendering
-- as alt=""). There is no third state, and this is a constraint rather than a
-- form validation because the importer and the seed write this table too.
-- ---------------------------------------------------------------------------
ALTER TABLE "content_assets"
  ADD CONSTRAINT "content_assets_images_need_alt_text"
  CHECK (
    mime NOT LIKE 'image/%'
    OR is_decorative
    OR (alt_text IS NOT NULL AND btrim(alt_text) <> '')
  );--> statement-breakpoint

-- A decorative image with alt text is a contradiction: one of the two is
-- wrong, and silently preferring either would be a guess about what a screen
-- reader should say.
ALTER TABLE "content_assets"
  ADD CONSTRAINT "content_assets_decorative_has_no_alt"
  CHECK (NOT is_decorative OR alt_text IS NULL OR btrim(alt_text) = '');--> statement-breakpoint

-- Only an image can be decorative.
ALTER TABLE "content_assets"
  ADD CONSTRAINT "content_assets_decorative_is_image"
  CHECK (NOT is_decorative OR mime LIKE 'image/%');--> statement-breakpoint

ALTER TABLE "content_assets"
  ADD CONSTRAINT "content_assets_bytes_nonnegative"
  CHECK (bytes >= 0);--> statement-breakpoint

COMMENT ON COLUMN "content_assets"."alt_text" IS
  'REQUIRED on image/* unless is_decorative. Enforced by CHECK content_assets_images_need_alt_text, not by the form.';--> statement-breakpoint

COMMENT ON COLUMN "content_assets"."ai_generated" IS
  'True when the image was machine-generated. The public site publishes an AI disclosure page; an asset that cannot say what it is makes that page a fiction.';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. NO SEND WITHOUT AN EXPLICIT HUMAN CONFIRMATION.
--
-- This is the constraint the whole email module exists around.
-- ---------------------------------------------------------------------------
ALTER TABLE "campaigns"
  ADD CONSTRAINT "campaigns_send_requires_human_confirmation"
  CHECK (
    status NOT IN ('sending', 'sent')
    OR (
      approved_by             IS NOT NULL
      AND approved_at         IS NOT NULL
      AND send_confirmation_token IS NOT NULL
      AND send_confirmed_at   IS NOT NULL
    )
  );--> statement-breakpoint

COMMENT ON TABLE "campaigns" IS
$comment$
WHY THIS TABLE IS CONSTRAINED THE WAY IT IS.

WACA's list is roughly 3,246 real people: members, legislative staff, agency
contacts and journalists. Sending to them is irreversible. There is no recall,
no edit-after-send, and a bad send costs the association its standing with the
exact audience it exists to influence.

So a row here CANNOT reach status 'sending' or 'sent' unless all four of
these are set:

    approved_by             a named human being, FK to users, ON DELETE RESTRICT
    approved_at             when they approved it
    send_confirmation_token unguessable, single-use, minted at approval
    send_confirmed_at       when that token was redeemed

That is CHECK campaigns_send_requires_human_confirmation, reinforced by
TRIGGER campaigns_status_transition_guard, which additionally refuses an
expired or already-redeemed token and refuses to let a campaign change its
category after it leaves 'draft'.

It is written here, in the database, and not in the composer, because the
composer is not the only thing that will ever UPDATE this row. A cron job
will. A retry will. An importer will. An agent might. A bug certainly will.
None of them can blast 3,246 real people, because none of them can produce a
human approver and a live confirmation token.

Do not relax this constraint to make a test pass. Set the fields.
$comment$;--> statement-breakpoint

COMMENT ON COLUMN "campaigns"."send_confirmation_token" IS
  'Minted at approval, presented back at dispatch, single-use. Redeem it with a conditional UPDATE and treat zero rows affected as a refusal to send.';--> statement-breakpoint

-- Every campaign has a plain-text part. A draft has not been rendered yet, so
-- the requirement bites the moment it leaves 'draft' -- which is the moment it
-- becomes something that could be sent.
ALTER TABLE "campaigns"
  ADD CONSTRAINT "campaigns_text_body_required"
  CHECK (status = 'draft' OR btrim(text_body) <> '');--> statement-breakpoint

ALTER TABLE "campaigns"
  ADD CONSTRAINT "campaigns_audience_required"
  CHECK (status = 'draft' OR audience_id IS NOT NULL);--> statement-breakpoint

ALTER TABLE "campaigns"
  ADD CONSTRAINT "campaigns_scheduled_needs_time"
  CHECK (status <> 'scheduled' OR scheduled_at IS NOT NULL);--> statement-breakpoint

ALTER TABLE "campaigns"
  ADD CONSTRAINT "campaigns_sent_needs_sent_at"
  CHECK (status <> 'sent' OR sent_at IS NOT NULL);--> statement-breakpoint

ALTER TABLE "campaigns"
  ADD CONSTRAINT "campaigns_from_email_shape"
  CHECK (from_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$');--> statement-breakpoint

ALTER TABLE "campaigns"
  ADD CONSTRAINT "campaigns_counts_nonnegative"
  CHECK (
    recipient_count >= 0 AND sent_count >= 0 AND delivered_count >= 0
    AND unique_open_count >= 0 AND unique_click_count >= 0
    AND bounce_count >= 0 AND complaint_count >= 0
    AND unsubscribe_count >= 0 AND failed_count >= 0
    AND suppressed_count >= 0
  );--> statement-breakpoint

ALTER TABLE "email_templates"
  ADD CONSTRAINT "email_templates_text_body_required"
  CHECK (btrim(text_body) <> '');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The transition guard. Legal moves, and the confirmation re-checked at the
-- exact moment it matters.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.campaigns_guard_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- Legal transitions. 'sent' and 'cancelled' are terminal.
    IF NOT (
      (OLD.status = 'draft'     AND NEW.status IN ('ready','cancelled'))
   OR (OLD.status = 'ready'     AND NEW.status IN ('draft','scheduled','sending','cancelled'))
   OR (OLD.status = 'scheduled' AND NEW.status IN ('ready','sending','paused','cancelled'))
   OR (OLD.status = 'sending'   AND NEW.status IN ('sent','paused','failed'))
   OR (OLD.status = 'paused'    AND NEW.status IN ('sending','cancelled','failed'))
   OR (OLD.status = 'failed'    AND NEW.status IN ('ready','cancelled'))
    ) THEN
      RAISE EXCEPTION
        'campaign % may not move from % to %', NEW.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;

    -- Entering 'sending' from anything but a pause is a NEW dispatch and needs
    -- a live confirmation. Resuming a paused send does not: it was already
    -- confirmed, and re-confirming a half-delivered blast helps nobody.
    IF NEW.status = 'sending' AND OLD.status <> 'paused' THEN
      IF NEW.approved_by IS NULL OR NEW.approved_at IS NULL THEN
        RAISE EXCEPTION
          'campaign % cannot send: no human approver on the row', NEW.id
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.send_confirmation_token IS NULL OR NEW.send_confirmed_at IS NULL THEN
        RAISE EXCEPTION
          'campaign % cannot send: send confirmation token was never redeemed', NEW.id
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.send_confirmation_expires_at IS NOT NULL
         AND NEW.send_confirmed_at > NEW.send_confirmation_expires_at THEN
        RAISE EXCEPTION
          'campaign % cannot send: send confirmation token had expired', NEW.id
          USING ERRCODE = 'check_violation';
      END IF;
      -- SINGLE USE. The token must be redeemed BY THIS UPDATE -- i.e. the row
      -- goes to 'sending' and stamps send_confirmed_at in the same statement.
      -- A token that was already redeemed on an earlier dispatch cannot be
      -- reused; re-sending means a fresh approval and a fresh token.
      IF NOT (
        OLD.send_confirmed_at IS NULL
        OR NEW.send_confirmation_token IS DISTINCT FROM OLD.send_confirmation_token
      ) THEN
        RAISE EXCEPTION
          'campaign % cannot send: that confirmation token has already been used', NEW.id
          USING ERRCODE = 'check_violation',
                HINT = 'Redeem the token in the same UPDATE that sets status to sending, or mint a new one by re-approving.';
      END IF;
    END IF;
  END IF;

  -- A campaign may not re-categorise itself once it has left 'draft'. Category
  -- is what category-scoped unsubscribes are matched against; letting a send
  -- relabel itself would be a way around a suppression.
  IF OLD.status <> 'draft' AND NEW.category IS DISTINCT FROM OLD.category THEN
    RAISE EXCEPTION
      'campaign % may not change category after leaving draft', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;--> statement-breakpoint

CREATE TRIGGER campaigns_status_transition_guard
  BEFORE UPDATE ON "campaigns"
  FOR EACH ROW EXECUTE FUNCTION public.campaigns_guard_status_transition();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. SUPPRESSION, ENFORCED AT INSERT.
--
-- Addresses normalise to lower(btrim(...)) on the way in, on BOTH tables, so
-- the unique index on suppressions.email is the whole uniqueness story and no
-- caller anywhere has to remember to lower-case before comparing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalize_email_column()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  NEW.email := lower(btrim(NEW.email));
  IF NEW.email = '' THEN
    RAISE EXCEPTION 'email may not be blank' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;--> statement-breakpoint

CREATE TRIGGER suppressions_normalize_email
  BEFORE INSERT OR UPDATE OF email ON "suppressions"
  FOR EACH ROW EXECUTE FUNCTION public.normalize_email_column();--> statement-breakpoint

CREATE TRIGGER campaign_recipients_normalize_email
  BEFORE INSERT OR UPDATE OF email ON "campaign_recipients"
  FOR EACH ROW EXECUTE FUNCTION public.normalize_email_column();--> statement-breakpoint

-- THE lookup. One definition of "is this address suppressed?", used by the
-- trigger below, by the RLS-safe send path, and by isSuppressed() in
-- src/db/queries/email.ts.
CREATE OR REPLACE FUNCTION public.is_suppressed(p_email text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.suppressions
     WHERE email = lower(btrim(coalesce(p_email, '')))
  );
$fn$;--> statement-breakpoint

COMMENT ON FUNCTION public.is_suppressed(text) IS
  'Is this address on the global suppression list? The single definition, shared by the campaign_recipients trigger and by the application query helper.';--> statement-breakpoint

-- Refuse, loudly. Not "insert it as status suppressed" -- a silent skip is how
-- a suppressed address ends up in a send six months later when somebody
-- changes the status filter. buildRecipients() anti-joins suppressions before
-- it inserts, so in normal operation this never fires; when it does fire, a
-- code path was skipping the list and the send should stop.
CREATE OR REPLACE FUNCTION public.campaign_recipients_reject_suppressed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF public.is_suppressed(NEW.email) THEN
    RAISE EXCEPTION
      'refusing to add a suppressed address to campaign %: this address is on the global suppression list',
      NEW.campaign_id
      USING ERRCODE = 'check_violation',
            HINT = 'Filter with is_suppressed()/buildRecipients() before inserting. Do not remove the suppression to make the insert succeed.';
  END IF;
  RETURN NEW;
END;
$fn$;--> statement-breakpoint

-- AFTER the normalisation trigger: names sort alphabetically within the same
-- timing, and "campaign_recipients_normalize_email" < "campaign_recipients_z_reject_suppressed".
CREATE TRIGGER campaign_recipients_z_reject_suppressed
  BEFORE INSERT OR UPDATE OF email ON "campaign_recipients"
  FOR EACH ROW EXECUTE FUNCTION public.campaign_recipients_reject_suppressed();--> statement-breakpoint

COMMENT ON TABLE "suppressions" IS
  'THE global suppression list. Every send consults it and campaign_recipients has a BEFORE INSERT trigger that refuses a row for an address on it. This is the table that keeps WACA out of trouble; it is enforced in the database because the composer is not the only thing that inserts recipients.';--> statement-breakpoint

ALTER TABLE "suppressions"
  ADD CONSTRAINT "suppressions_email_shape"
  CHECK (email = lower(btrim(email)) AND email <> '');--> statement-breakpoint

ALTER TABLE "campaign_recipients"
  ADD CONSTRAINT "campaign_recipients_email_normalized"
  CHECK (email = lower(btrim(email)) AND email <> '');--> statement-breakpoint

ALTER TABLE "campaign_recipients"
  ADD CONSTRAINT "campaign_recipients_counts_nonnegative"
  CHECK (open_count >= 0 AND click_count >= 0);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. UNSUBSCRIBE TOKENS.
-- ---------------------------------------------------------------------------
ALTER TABLE "unsubscribe_tokens"
  ADD CONSTRAINT "unsubscribe_tokens_scope_category"
  CHECK (
    (scope = 'category' AND category IS NOT NULL)
    OR (scope = 'all' AND category IS NULL)
  );--> statement-breakpoint

-- sha256 hex. Rejects anyone tempted to store the raw token here.
ALTER TABLE "unsubscribe_tokens"
  ADD CONSTRAINT "unsubscribe_tokens_hash_shape"
  CHECK (token_hash ~ '^[0-9a-f]{64}$');--> statement-breakpoint

COMMENT ON COLUMN "unsubscribe_tokens"."token_hash" IS
  'sha256(raw token), hex. The raw token exists only in the email that carried it: a database dump must not become a list of working unsubscribe URLs.';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. updated_at triggers for the new tables.
--    Same touch_updated_at() function installed by 0001.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'content_types','content_items','content_assets',
    'audiences','email_templates','campaigns','campaign_recipients'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgname = t || '_touch_updated_at_trg'
         AND tgrelid = format('public.%I', t)::regclass
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()',
        t || '_touch_updated_at_trg', t);
    END IF;
  END LOOP;
END $do$;
