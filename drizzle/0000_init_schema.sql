-- ---------------------------------------------------------------------------
-- Extensions. Must run before the trigram indexes further down this file.
-- All are available on Supabase; CREATE EXTENSION IF NOT EXISTS is a no-op
-- there if the project already has them enabled.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "btree_gin";--> statement-breakpoint
CREATE TYPE "public"."application_status" AS ENUM('draft', 'submitted', 'under-review', 'approved', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."application_type" AS ENUM('new', 'renewal', 'level-change');--> statement-breakpoint
CREATE TYPE "public"."audit_action" AS ENUM('create', 'update', 'delete', 'archive', 'restore', 'login', 'logout', 'status-change', 'approve', 'reject', 'invoice-send', 'payment-record', 'refund-record', 'allocation-change', 'check-in', 'export', 'import');--> statement-breakpoint
CREATE TYPE "public"."billing_period" AS ENUM('annual', 'monthly', 'lifetime');--> statement-breakpoint
CREATE TYPE "public"."contact_field_type" AS ENUM('text', 'textarea', 'number', 'boolean', 'date', 'select', 'multiselect', 'email', 'phone', 'url');--> statement-breakpoint
CREATE TYPE "public"."council_role" AS ENUM('member', 'chair', 'vice-chair', 'staff-liaison');--> statement-breakpoint
CREATE TYPE "public"."document_access_scope" AS ENUM('public', 'members', 'level-restricted', 'council-restricted');--> statement-breakpoint
CREATE TYPE "public"."document_category" AS ENUM('legislative-agenda', 'detail-report', 'testimony', 'comment-letter', 'press-release', 'position-paper', 'report', 'event-material');--> statement-breakpoint
CREATE TYPE "public"."event_kind" AS ENUM('conference', 'day-on-the-hill', 'sector-council', 'member-meeting', 'fundraiser', 'webinar', 'workshop', 'sponsorship');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('draft', 'published', 'cancelled', 'completed');--> statement-breakpoint
CREATE TYPE "public"."event_visibility" AS ENUM('public', 'members-only', 'invite-only', 'admin-only');--> statement-breakpoint
CREATE TYPE "public"."invoice_source" AS ENUM('membership-new', 'membership-renewal', 'membership-level-change', 'event-registration', 'sponsorship', 'donation', 'other');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'sent', 'paid', 'partially-paid', 'void', 'overdue');--> statement-breakpoint
CREATE TYPE "public"."license_type" AS ENUM('retail', 'producer', 'processor', 'producer-processor', 'lab', 'transport', 'none');--> statement-breakpoint
CREATE TYPE "public"."member_category" AS ENUM('retailer', 'producer-processor', 'lab-transport', 'ancillary');--> statement-breakpoint
CREATE TYPE "public"."membership_level_type" AS ENUM('full', 'associate', 'limited', 'monthly', 'admin');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('active', 'renewal-overdue', 'lapsed', 'pending-new', 'pending-renewal', 'pending-level-change');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cheque', 'ach', 'bank-transfer', 'cash', 'in-kind', 'write-off', 'other-offline');--> statement-breakpoint
CREATE TYPE "public"."refund_method" AS ENUM('cheque', 'ach', 'bank-transfer', 'credit-note', 'other-offline');--> statement-breakpoint
CREATE TYPE "public"."registration_status" AS ENUM('pending', 'confirmed', 'cancelled', 'waitlisted');--> statement-breakpoint
CREATE TYPE "public"."reminder_channel" AS ENUM('email', 'in-app');--> statement-breakpoint
CREATE TYPE "public"."reminder_delivery_status" AS ENUM('queued', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."reminder_offset_kind" AS ENUM('before-expiry', 'after-expiry');--> statement-breakpoint
CREATE TYPE "public"."renewal_anchor" AS ENUM('join_date', 'calendar');--> statement-breakpoint
CREATE TYPE "public"."revenue_band" AS ENUM('over-5m', '1m-4.9m', '150k-1m', 'under-1m', 'under-150k', 'not-disclosed');--> statement-breakpoint
CREATE TYPE "public"."sponsorship_status" AS ENUM('proposed', 'confirmed', 'invoiced', 'paid', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'staff', 'bundle_admin', 'member');--> statement-breakpoint
CREATE TABLE "accounts" (
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "authenticators" (
	"credential_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_account_id" text NOT NULL,
	"credential_public_key" text NOT NULL,
	"counter" integer NOT NULL,
	"credential_device_type" text NOT NULL,
	"credential_backed_up" boolean NOT NULL,
	"transports" text,
	CONSTRAINT "authenticators_user_id_credential_id_pk" PRIMARY KEY("user_id","credential_id"),
	CONSTRAINT "authenticators_credentialID_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"email" text NOT NULL,
	"email_verified" timestamp with time zone,
	"image" text,
	"password_hash" text,
	"role" "user_role" DEFAULT 'member' NOT NULL,
	"contact_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "contact_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" "contact_field_type" DEFAULT 'text' NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"help_text" text,
	"required" boolean DEFAULT false NOT NULL,
	"member_visible" boolean DEFAULT true NOT NULL,
	"member_editable" boolean DEFAULT false NOT NULL,
	"applies_to" text DEFAULT 'contact' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"mobile" text,
	"title" text,
	"organization_id" uuid,
	"is_bundle_admin" boolean DEFAULT false NOT NULL,
	"is_primary_contact" boolean DEFAULT false NOT NULL,
	"user_id" uuid,
	"contact_field_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"email_opt_in" boolean DEFAULT true NOT NULL,
	"directory_opt_in" boolean DEFAULT false NOT NULL,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legal_name" text NOT NULL,
	"display_name" text NOT NULL,
	"slug" text NOT NULL,
	"category" "member_category" NOT NULL,
	"revenue_band" "revenue_band" DEFAULT 'not-disclosed' NOT NULL,
	"license_numbers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"license_types" "license_type"[] DEFAULT '{}' NOT NULL,
	"website" text,
	"logo_url" text,
	"logo_file_key" text,
	"phone" text,
	"email" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state" text DEFAULT 'WA',
	"postal_code" text,
	"country" text DEFAULT 'US' NOT NULL,
	"public_listing_consent" boolean DEFAULT false NOT NULL,
	"public_description" text,
	"member_since" timestamp with time zone,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "application_type" NOT NULL,
	"status" "application_status" DEFAULT 'submitted' NOT NULL,
	"organization_id" uuid,
	"membership_id" uuid,
	"requested_level_id" uuid NOT NULL,
	"current_level_id" uuid,
	"submitted_by_contact_id" uuid,
	"applicant_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"declared_revenue_band" "revenue_band",
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_user_id" uuid,
	"decision_notes" text,
	"invoice_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"type" "membership_level_type" NOT NULL,
	"fee_cents" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"billing_period" "billing_period" DEFAULT 'annual' NOT NULL,
	"renewal_anchor" "renewal_anchor" DEFAULT 'join_date' NOT NULL,
	"renewal_anchor_day" integer,
	"public_applications" boolean DEFAULT true NOT NULL,
	"auto_renew_default" boolean DEFAULT false NOT NULL,
	"revenue_band_min_cents" bigint,
	"revenue_band_max_cents" bigint,
	"revenue_band" "revenue_band",
	"description" text,
	"benefits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"level_id" uuid NOT NULL,
	"status" "membership_status" DEFAULT 'pending-new' NOT NULL,
	"joined_on" date NOT NULL,
	"term_starts_on" date,
	"expires_on" date,
	"auto_renew" boolean DEFAULT false NOT NULL,
	"renewal_reminders_sent" integer DEFAULT 0 NOT NULL,
	"last_reminder_sent_at" timestamp with time zone,
	"is_current" boolean DEFAULT true NOT NULL,
	"fee_charged_cents" bigint,
	"notes" text,
	"lapsed_on" date,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "renewal_reminder_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"level_id" uuid,
	"offset_kind" "reminder_offset_kind" NOT NULL,
	"offset_days" integer NOT NULL,
	"channel" "reminder_channel" DEFAULT 'email' NOT NULL,
	"template_key" text NOT NULL,
	"subject" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "renewal_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"membership_id" uuid NOT NULL,
	"rule_id" uuid,
	"contact_id" uuid,
	"due_for_expires_on" date NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"status" "reminder_delivery_status" DEFAULT 'queued' NOT NULL,
	"channel" "reminder_channel" DEFAULT 'email' NOT NULL,
	"provider_message_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "council_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"council_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"organization_id" uuid,
	"role" "council_role" DEFAULT 'member' NOT NULL,
	"auto_enrolled" boolean DEFAULT true NOT NULL,
	"enrolled_via_license_type" "license_type",
	"joined_on" date NOT NULL,
	"left_on" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "council_priorities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"council_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"policy_year" integer NOT NULL,
	"rank" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"related_bills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"elevated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "councils" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"auto_enroll_license_types" "license_type"[] DEFAULT '{}' NOT NULL,
	"staff_liaison_contact_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"room" text,
	"speakers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capacity" integer,
	"requires_signup" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_sponsorships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"sponsor_tier_id" uuid NOT NULL,
	"organization_id" uuid,
	"sponsor_name" text NOT NULL,
	"contact_id" uuid,
	"status" "sponsorship_status" DEFAULT 'proposed' NOT NULL,
	"amount_cents" bigint DEFAULT 0 NOT NULL,
	"fulfilment_notes" text,
	"benefits_delivered" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"invoice_id" uuid,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"kind" "event_kind" NOT NULL,
	"status" "event_status" DEFAULT 'draft' NOT NULL,
	"visibility" "event_visibility" DEFAULT 'members-only' NOT NULL,
	"summary" text,
	"description" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"timezone" text DEFAULT 'America/Los_Angeles' NOT NULL,
	"venue_name" text,
	"venue_address" text,
	"city" text,
	"state" text DEFAULT 'WA',
	"is_virtual" boolean DEFAULT false NOT NULL,
	"virtual_url" text,
	"capacity" integer,
	"registration_opens_at" timestamp with time zone,
	"registration_closes_at" timestamp with time zone,
	"waitlist_enabled" boolean DEFAULT false NOT NULL,
	"paired_sponsorship_event_id" uuid,
	"council_id" uuid,
	"registered_count" integer DEFAULT 0 NOT NULL,
	"attended_count" integer DEFAULT 0 NOT NULL,
	"banner_image_url" text,
	"contact_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"ticket_type_id" uuid NOT NULL,
	"contact_id" uuid,
	"organization_id" uuid,
	"status" "registration_status" DEFAULT 'pending' NOT NULL,
	"attendee_name" text NOT NULL,
	"attendee_email" text NOT NULL,
	"attendee_title" text,
	"attendee_organization_name" text,
	"guest_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"price_paid_cents" bigint DEFAULT 0 NOT NULL,
	"invoice_id" uuid,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"checked_in_at" timestamp with time zone,
	"checked_in_by_user_id" uuid,
	"waitlist_position" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sponsor_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"price_cents" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"benefits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inventory" integer,
	"sold_count" integer DEFAULT 0 NOT NULL,
	"included_tickets" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_cents" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"capacity" integer,
	"sold_count" integer DEFAULT 0 NOT NULL,
	"available_from" timestamp with time zone,
	"available_until" timestamp with time zone,
	"member_only" boolean DEFAULT false NOT NULL,
	"level_restrictions" uuid[] DEFAULT '{}' NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"min_per_order" integer DEFAULT 1 NOT NULL,
	"max_per_order" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price_cents" bigint DEFAULT 0 NOT NULL,
	"amount_cents" bigint DEFAULT 0 NOT NULL,
	"discount_cents" bigint DEFAULT 0 NOT NULL,
	"tax_cents" bigint DEFAULT 0 NOT NULL,
	"gl_code" text,
	"membership_level_id" uuid,
	"ticket_type_id" uuid,
	"sponsor_tier_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_lines_quantity_positive" CHECK ("invoice_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"organization_id" uuid,
	"contact_id" uuid,
	"source" "invoice_source" DEFAULT 'other' NOT NULL,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"membership_id" uuid,
	"membership_application_id" uuid,
	"event_id" uuid,
	"registration_id" uuid,
	"event_sponsorship_id" uuid,
	"currency" text DEFAULT 'USD' NOT NULL,
	"subtotal_cents" bigint DEFAULT 0 NOT NULL,
	"tax_cents" bigint DEFAULT 0 NOT NULL,
	"discount_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"amount_paid_cents" bigint DEFAULT 0 NOT NULL,
	"amount_refunded_cents" bigint DEFAULT 0 NOT NULL,
	"issued_on" date,
	"due_on" date,
	"sent_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"bill_to_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payment_terms" text,
	"memo" text,
	"internal_notes" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_totals_non_negative" CHECK ("invoices"."total_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"allocated_on" date NOT NULL,
	"allocated_by_user_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_allocations_amount_positive" CHECK ("payment_allocations"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"contact_id" uuid,
	"method" "payment_method" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"received_on" date NOT NULL,
	"deposited_on" date,
	"reference" text,
	"bank_account_label" text,
	"unapplied_cents" bigint DEFAULT 0 NOT NULL,
	"notes" text,
	"recorded_by_user_id" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid,
	"payment_id" uuid,
	"organization_id" uuid,
	"amount_cents" bigint NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"method" "refund_method" NOT NULL,
	"refunded_on" date NOT NULL,
	"reference" text,
	"reason" text,
	"recorded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_amount_positive" CHECK ("refunds"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "document_downloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"contact_id" uuid,
	"user_id" uuid,
	"ip_address" text,
	"user_agent" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"category" "document_category" NOT NULL,
	"access_scope" "document_access_scope" DEFAULT 'members' NOT NULL,
	"level_restrictions" uuid[] DEFAULT '{}' NOT NULL,
	"council_restrictions" uuid[] DEFAULT '{}' NOT NULL,
	"file_key" text NOT NULL,
	"file_name" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"pages" integer,
	"checksum_sha256" text,
	"published_on" date,
	"policy_year" integer,
	"related_bills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"is_ocr_needed" boolean DEFAULT false NOT NULL,
	"ocr_completed_at" timestamp with time zone,
	"extracted_text" text,
	"event_id" uuid,
	"council_id" uuid,
	"uploaded_by_contact_id" uuid,
	"download_count" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"actor_contact_id" uuid,
	"actor_label" text,
	"action" "audit_action" NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid,
	"diff" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticators" ADD CONSTRAINT "authenticators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_applications" ADD CONSTRAINT "membership_applications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_applications" ADD CONSTRAINT "membership_applications_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_applications" ADD CONSTRAINT "membership_applications_requested_level_id_membership_levels_id_fk" FOREIGN KEY ("requested_level_id") REFERENCES "public"."membership_levels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_applications" ADD CONSTRAINT "membership_applications_current_level_id_membership_levels_id_fk" FOREIGN KEY ("current_level_id") REFERENCES "public"."membership_levels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_applications" ADD CONSTRAINT "membership_applications_submitted_by_contact_id_contacts_id_fk" FOREIGN KEY ("submitted_by_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_level_id_membership_levels_id_fk" FOREIGN KEY ("level_id") REFERENCES "public"."membership_levels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renewal_reminder_rules" ADD CONSTRAINT "renewal_reminder_rules_level_id_membership_levels_id_fk" FOREIGN KEY ("level_id") REFERENCES "public"."membership_levels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renewal_reminders" ADD CONSTRAINT "renewal_reminders_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renewal_reminders" ADD CONSTRAINT "renewal_reminders_rule_id_renewal_reminder_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."renewal_reminder_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renewal_reminders" ADD CONSTRAINT "renewal_reminders_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "council_members" ADD CONSTRAINT "council_members_council_id_councils_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."councils"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "council_members" ADD CONSTRAINT "council_members_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "council_members" ADD CONSTRAINT "council_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "council_priorities" ADD CONSTRAINT "council_priorities_council_id_councils_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."councils"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "councils" ADD CONSTRAINT "councils_staff_liaison_contact_id_contacts_id_fk" FOREIGN KEY ("staff_liaison_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_sessions" ADD CONSTRAINT "event_sessions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_sponsorships" ADD CONSTRAINT "event_sponsorships_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_sponsorships" ADD CONSTRAINT "event_sponsorships_sponsor_tier_id_sponsor_tiers_id_fk" FOREIGN KEY ("sponsor_tier_id") REFERENCES "public"."sponsor_tiers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_sponsorships" ADD CONSTRAINT "event_sponsorships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_sponsorships" ADD CONSTRAINT "event_sponsorships_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_council_id_councils_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."councils"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_ticket_type_id_ticket_types_id_fk" FOREIGN KEY ("ticket_type_id") REFERENCES "public"."ticket_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsor_tiers" ADD CONSTRAINT "sponsor_tiers_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_types" ADD CONSTRAINT "ticket_types_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_membership_application_id_membership_applications_id_fk" FOREIGN KEY ("membership_application_id") REFERENCES "public"."membership_applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_event_sponsorship_id_event_sponsorships_id_fk" FOREIGN KEY ("event_sponsorship_id") REFERENCES "public"."event_sponsorships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_downloads" ADD CONSTRAINT "document_downloads_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_downloads" ADD CONSTRAINT "document_downloads_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_council_id_councils_id_fk" FOREIGN KEY ("council_id") REFERENCES "public"."councils"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_contact_id_contacts_id_fk" FOREIGN KEY ("uploaded_by_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role");--> statement-breakpoint
CREATE INDEX "users_contact_id_idx" ON "users" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_fields_key_uq" ON "contact_fields" USING btree ("key");--> statement-breakpoint
CREATE INDEX "contact_fields_sort_idx" ON "contact_fields" USING btree ("sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_email_uq" ON "contacts" USING btree ("email");--> statement-breakpoint
CREATE INDEX "contacts_organization_id_idx" ON "contacts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "contacts_user_id_idx" ON "contacts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "contacts_archived_at_idx" ON "contacts" USING btree ("archived_at");--> statement-breakpoint
CREATE INDEX "contacts_org_bundle_admin_idx" ON "contacts" USING btree ("organization_id","is_bundle_admin");--> statement-breakpoint
CREATE INDEX "contacts_display_name_trgm_idx" ON "contacts" USING gin ("display_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_email_trgm_idx" ON "contacts" USING gin ("email" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_custom_fields_gin_idx" ON "contacts" USING gin ("contact_field_values" jsonb_path_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_uq" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "organizations_category_idx" ON "organizations" USING btree ("category");--> statement-breakpoint
CREATE INDEX "organizations_archived_at_idx" ON "organizations" USING btree ("archived_at");--> statement-breakpoint
CREATE INDEX "organizations_public_listing_idx" ON "organizations" USING btree ("public_listing_consent","category");--> statement-breakpoint
CREATE INDEX "organizations_display_name_trgm_idx" ON "organizations" USING gin ("display_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "organizations_legal_name_trgm_idx" ON "organizations" USING gin ("legal_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "membership_applications_status_idx" ON "membership_applications" USING btree ("status","submitted_at");--> statement-breakpoint
CREATE INDEX "membership_applications_org_idx" ON "membership_applications" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "membership_applications_type_status_idx" ON "membership_applications" USING btree ("type","status");--> statement-breakpoint
CREATE INDEX "membership_applications_membership_idx" ON "membership_applications" USING btree ("membership_id");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_levels_slug_uq" ON "membership_levels" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_levels_name_uq" ON "membership_levels" USING btree ("name");--> statement-breakpoint
CREATE INDEX "membership_levels_sort_idx" ON "membership_levels" USING btree ("sort_order");--> statement-breakpoint
CREATE INDEX "membership_levels_public_idx" ON "membership_levels" USING btree ("public_applications","is_active");--> statement-breakpoint
CREATE INDEX "memberships_organization_id_idx" ON "memberships" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "memberships_level_id_idx" ON "memberships" USING btree ("level_id");--> statement-breakpoint
CREATE INDEX "memberships_status_expires_on_idx" ON "memberships" USING btree ("status","expires_on");--> statement-breakpoint
CREATE INDEX "memberships_expires_on_idx" ON "memberships" USING btree ("expires_on");--> statement-breakpoint
CREATE INDEX "memberships_auto_renew_expires_idx" ON "memberships" USING btree ("auto_renew","expires_on");--> statement-breakpoint
CREATE INDEX "memberships_is_current_idx" ON "memberships" USING btree ("is_current","status");--> statement-breakpoint
CREATE UNIQUE INDEX "renewal_reminder_rules_uq" ON "renewal_reminder_rules" USING btree (coalesce("level_id", '00000000-0000-0000-0000-000000000000'::uuid),"offset_kind","offset_days","channel");--> statement-breakpoint
CREATE INDEX "renewal_reminder_rules_active_idx" ON "renewal_reminder_rules" USING btree ("is_active","offset_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "renewal_reminders_dedupe_uq" ON "renewal_reminders" USING btree ("membership_id","rule_id","due_for_expires_on");--> statement-breakpoint
CREATE INDEX "renewal_reminders_status_scheduled_idx" ON "renewal_reminders" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "renewal_reminders_membership_idx" ON "renewal_reminders" USING btree ("membership_id");--> statement-breakpoint
CREATE UNIQUE INDEX "council_members_council_contact_uq" ON "council_members" USING btree ("council_id","contact_id");--> statement-breakpoint
CREATE INDEX "council_members_council_active_idx" ON "council_members" USING btree ("council_id","is_active");--> statement-breakpoint
CREATE INDEX "council_members_contact_idx" ON "council_members" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "council_members_org_idx" ON "council_members" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "council_priorities_council_year_idx" ON "council_priorities" USING btree ("council_id","policy_year");--> statement-breakpoint
CREATE INDEX "council_priorities_rank_idx" ON "council_priorities" USING btree ("policy_year","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "councils_slug_uq" ON "councils" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "councils_active_sort_idx" ON "councils" USING btree ("is_active","sort_order");--> statement-breakpoint
CREATE INDEX "event_sessions_event_starts_idx" ON "event_sessions" USING btree ("event_id","starts_at");--> statement-breakpoint
CREATE INDEX "event_sessions_event_sort_idx" ON "event_sessions" USING btree ("event_id","sort_order");--> statement-breakpoint
CREATE INDEX "event_sponsorships_event_status_idx" ON "event_sponsorships" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX "event_sponsorships_org_idx" ON "event_sponsorships" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "event_sponsorships_tier_idx" ON "event_sponsorships" USING btree ("sponsor_tier_id");--> statement-breakpoint
CREATE INDEX "event_sponsorships_invoice_idx" ON "event_sponsorships" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_slug_uq" ON "events" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "events_visibility_status_starts_idx" ON "events" USING btree ("visibility","status","starts_at");--> statement-breakpoint
CREATE INDEX "events_starts_at_idx" ON "events" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "events_kind_starts_idx" ON "events" USING btree ("kind","starts_at");--> statement-breakpoint
CREATE INDEX "events_status_starts_idx" ON "events" USING btree ("status","starts_at");--> statement-breakpoint
CREATE INDEX "events_council_idx" ON "events" USING btree ("council_id");--> statement-breakpoint
CREATE INDEX "events_paired_sponsorship_idx" ON "events" USING btree ("paired_sponsorship_event_id");--> statement-breakpoint
CREATE INDEX "registrations_event_status_idx" ON "registrations" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX "registrations_event_checked_in_idx" ON "registrations" USING btree ("event_id","checked_in_at");--> statement-breakpoint
CREATE INDEX "registrations_contact_idx" ON "registrations" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "registrations_organization_idx" ON "registrations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "registrations_ticket_type_idx" ON "registrations" USING btree ("ticket_type_id");--> statement-breakpoint
CREATE INDEX "registrations_invoice_idx" ON "registrations" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "registrations_attendee_email_idx" ON "registrations" USING btree ("attendee_email");--> statement-breakpoint
CREATE UNIQUE INDEX "registrations_event_contact_ticket_uq" ON "registrations" USING btree ("event_id","contact_id","ticket_type_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sponsor_tiers_event_name_uq" ON "sponsor_tiers" USING btree ("event_id","name");--> statement-breakpoint
CREATE INDEX "sponsor_tiers_event_sort_idx" ON "sponsor_tiers" USING btree ("event_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_types_event_name_uq" ON "ticket_types" USING btree ("event_id","name");--> statement-breakpoint
CREATE INDEX "ticket_types_event_sort_idx" ON "ticket_types" USING btree ("event_id","sort_order");--> statement-breakpoint
CREATE INDEX "ticket_types_event_active_idx" ON "ticket_types" USING btree ("event_id","is_active");--> statement-breakpoint
CREATE INDEX "invoice_lines_invoice_sort_idx" ON "invoice_lines" USING btree ("invoice_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_number_uq" ON "invoices" USING btree ("number");--> statement-breakpoint
CREATE INDEX "invoices_status_due_on_idx" ON "invoices" USING btree ("status","due_on");--> statement-breakpoint
CREATE INDEX "invoices_organization_status_idx" ON "invoices" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "invoices_contact_idx" ON "invoices" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "invoices_issued_on_idx" ON "invoices" USING btree ("issued_on");--> statement-breakpoint
CREATE INDEX "invoices_source_status_idx" ON "invoices" USING btree ("source","status");--> statement-breakpoint
CREATE INDEX "invoices_membership_idx" ON "invoices" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "invoices_event_idx" ON "invoices" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_allocations_payment_invoice_uq" ON "payment_allocations" USING btree ("payment_id","invoice_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_invoice_idx" ON "payment_allocations" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_payment_idx" ON "payment_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payments_organization_received_idx" ON "payments" USING btree ("organization_id","received_on");--> statement-breakpoint
CREATE INDEX "payments_received_on_idx" ON "payments" USING btree ("received_on");--> statement-breakpoint
CREATE INDEX "payments_method_idx" ON "payments" USING btree ("method");--> statement-breakpoint
CREATE INDEX "payments_unapplied_idx" ON "payments" USING btree ("unapplied_cents");--> statement-breakpoint
CREATE INDEX "payments_reference_idx" ON "payments" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "refunds_invoice_idx" ON "refunds" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "refunds_payment_idx" ON "refunds" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "refunds_organization_refunded_idx" ON "refunds" USING btree ("organization_id","refunded_on");--> statement-breakpoint
CREATE INDEX "document_downloads_document_at_idx" ON "document_downloads" USING btree ("document_id","at");--> statement-breakpoint
CREATE INDEX "document_downloads_contact_idx" ON "document_downloads" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_slug_uq" ON "documents" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "documents_category_published_idx" ON "documents" USING btree ("category","published_on");--> statement-breakpoint
CREATE INDEX "documents_access_scope_idx" ON "documents" USING btree ("access_scope","published_on");--> statement-breakpoint
CREATE INDEX "documents_published_on_idx" ON "documents" USING btree ("published_on");--> statement-breakpoint
CREATE INDEX "documents_event_idx" ON "documents" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "documents_council_idx" ON "documents" USING btree ("council_id");--> statement-breakpoint
CREATE INDEX "documents_archived_at_idx" ON "documents" USING btree ("archived_at");--> statement-breakpoint
CREATE INDEX "documents_level_restrictions_gin_idx" ON "documents" USING gin ("level_restrictions");--> statement-breakpoint
CREATE INDEX "documents_council_restrictions_gin_idx" ON "documents" USING gin ("council_restrictions");--> statement-breakpoint
CREATE INDEX "documents_tags_gin_idx" ON "documents" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "documents_title_trgm_idx" ON "documents" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "audit_log_entity_entity_id_at_idx" ON "audit_log" USING btree ("entity","entity_id","at");--> statement-breakpoint
CREATE INDEX "audit_log_actor_at_idx" ON "audit_log" USING btree ("actor_user_id","at");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action","at");