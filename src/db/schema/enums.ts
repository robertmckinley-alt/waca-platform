import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Shared Postgres enums for the WACA platform.
 *
 * Every vocabulary here was verified against the live Wild Apricot account.
 * Values use kebab-case to match the strings the UI and API already speak.
 *
 * NOTE ON PAYMENTS: WACA does not process cards. `paymentMethodEnum` and
 * `refundMethodEnum` deliberately contain offline settlement methods only.
 * Do not add a card/credit/stripe value here — see DATABASE.md.
 */

/* ------------------------------------------------------------------ auth */

export const userRoleEnum = pgEnum("user_role", [
  "admin",
  "staff",
  "bundle_admin",
  "member",
]);

/* -------------------------------------------------------- organisations */

/** Public directory / sector-council categorisation. */
export const memberCategoryEnum = pgEnum("member_category", [
  "retailer",
  "producer-processor",
  "lab-transport",
  "ancillary",
]);

/**
 * Annual-revenue eligibility band. Drives which membership level an
 * organisation may apply for.
 *   over-5m    -> Full L1 / Associate L1
 *   1m-4.9m    -> Full L2
 *   150k-1m    -> Full L3
 *   under-1m   -> Associate L2 / Associate L3
 *   under-150k -> Full L4 / Limited
 */
export const revenueBandEnum = pgEnum("revenue_band", [
  "over-5m",
  "1m-4.9m",
  "150k-1m",
  "under-1m",
  "under-150k",
  "not-disclosed",
]);

/* ----------------------------------------------------------- membership */

export const membershipLevelTypeEnum = pgEnum("membership_level_type", [
  "full",
  "associate",
  "limited",
  "monthly",
  "admin",
]);

export const billingPeriodEnum = pgEnum("billing_period", [
  "annual",
  "monthly",
  "lifetime",
]);

/** join_date = anniversary of joining; calendar = fixed calendar anchor. */
export const renewalAnchorEnum = pgEnum("renewal_anchor", [
  "join_date",
  "calendar",
]);

export const membershipStatusEnum = pgEnum("membership_status", [
  "active",
  "renewal-overdue",
  "lapsed",
  "pending-new",
  "pending-renewal",
  "pending-level-change",
]);

export const applicationTypeEnum = pgEnum("application_type", [
  "new",
  "renewal",
  "level-change",
]);

export const applicationStatusEnum = pgEnum("application_status", [
  "draft",
  "submitted",
  "under-review",
  "approved",
  "rejected",
  "withdrawn",
]);

/** Reminder ladder: fires before or after the expiry date. */
export const reminderOffsetKindEnum = pgEnum("reminder_offset_kind", [
  "before-expiry",
  "after-expiry",
]);

export const reminderChannelEnum = pgEnum("reminder_channel", [
  "email",
  "in-app",
]);

export const reminderDeliveryStatusEnum = pgEnum("reminder_delivery_status", [
  "queued",
  "sent",
  "failed",
  "skipped",
]);

/* ------------------------------------------------------------- councils */

export const councilRoleEnum = pgEnum("council_role", [
  "member",
  "chair",
  "vice-chair",
  "staff-liaison",
]);

/** Licence types that drive auto-enrolment into a sector council. */
export const licenseTypeEnum = pgEnum("license_type", [
  "retail",
  "producer",
  "processor",
  "producer-processor",
  "lab",
  "transport",
  "none",
]);

/* --------------------------------------------------------------- events */

export const eventKindEnum = pgEnum("event_kind", [
  "conference",
  "day-on-the-hill",
  "sector-council",
  "member-meeting",
  "fundraiser",
  "webinar",
  "workshop",
  "sponsorship",
]);

/**
 * Visibility gate. The public API must filter to 'public' ONLY.
 * Legislator and congressional fundraisers are never 'public'.
 */
export const eventVisibilityEnum = pgEnum("event_visibility", [
  "public",
  "members-only",
  "invite-only",
  "admin-only",
]);

export const eventStatusEnum = pgEnum("event_status", [
  "draft",
  "published",
  "cancelled",
  "completed",
]);

export const registrationStatusEnum = pgEnum("registration_status", [
  "pending",
  "confirmed",
  "cancelled",
  "waitlisted",
]);

export const sponsorshipStatusEnum = pgEnum("sponsorship_status", [
  "proposed",
  "confirmed",
  "invoiced",
  "paid",
  "cancelled",
]);

/* -------------------------------------------------------------- finance */

export const invoiceStatusEnum = pgEnum("invoice_status", [
  "draft",
  "sent",
  "paid",
  "partially-paid",
  "void",
  "overdue",
]);

/** What caused this invoice to exist. */
export const invoiceSourceEnum = pgEnum("invoice_source", [
  "membership-new",
  "membership-renewal",
  "membership-level-change",
  "event-registration",
  "sponsorship",
  "donation",
  "other",
]);

/**
 * Offline settlement methods ONLY. WACA invoices and settles offline;
 * staff record the payment by hand. NO CARD PROCESSING — do not extend
 * this enum with card/credit/stripe values.
 */
export const paymentMethodEnum = pgEnum("payment_method", [
  "cheque",
  "ach",
  "bank-transfer",
  "cash",
  "in-kind",
  "write-off",
  "other-offline",
]);

export const refundMethodEnum = pgEnum("refund_method", [
  "cheque",
  "ach",
  "bank-transfer",
  "credit-note",
  "other-offline",
]);

/* ------------------------------------------------------------ documents */

export const documentCategoryEnum = pgEnum("document_category", [
  "legislative-agenda",
  "detail-report",
  "testimony",
  "comment-letter",
  "press-release",
  "position-paper",
  "report",
  "event-material",
]);

export const documentAccessScopeEnum = pgEnum("document_access_scope", [
  "public",
  "members",
  "level-restricted",
  "council-restricted",
]);

/* ---------------------------------------------------------------- audit */

export const auditActionEnum = pgEnum("audit_action", [
  "create",
  "update",
  "delete",
  "archive",
  "restore",
  "login",
  "logout",
  "status-change",
  "approve",
  "reject",
  "invoice-send",
  "payment-record",
  "refund-record",
  "allocation-change",
  "check-in",
  "export",
  "import",
]);

/* ------------------------------------------------------ custom fields */

export const contactFieldTypeEnum = pgEnum("contact_field_type", [
  "text",
  "textarea",
  "number",
  "boolean",
  "date",
  "select",
  "multiselect",
  "email",
  "phone",
  "url",
]);

/* --------------------------------------------------------------- content */

/**
 * The editable collections. These mirror the public Astro site's content
 * collections one-for-one (`waca-web/src/content.config.ts`) plus the three
 * data-file shapes it reads from `src/data/` (`stat`, `nav`, `setting`).
 *
 * This is an ENUM and not a free-text column on purpose. On an advocacy site
 * the taxonomy is editorial policy: adding a content type is a deliberate
 * migration, not something a typo in an admin form can invent. It is the same
 * stance the public site takes on its own frontmatter vocabularies.
 */
export const contentTypeKeyEnum = pgEnum("content_type_key", [
  "page",
  "press",
  "record",
  "agenda",
  "post",
  "person",
  "member",
  "stat",
  "nav",
  "setting",
]);

/**
 * Editorial workflow.
 *   draft      -- being written, invisible to the build
 *   in_review  -- awaiting a second pair of eyes
 *   scheduled  -- approved, waiting for publish_at
 *   published  -- in the snapshot at /api/content/*
 *   archived   -- withdrawn; kept for the record, never served
 *
 * Underscored rather than kebab-cased, matching the strings the CMS editor
 * and the module agents were specified against.
 */
export const contentStatusEnum = pgEnum("content_status", [
  "draft",
  "in_review",
  "scheduled",
  "published",
  "archived",
]);

/** Outcome of one "Publish" run -- one Vercel deploy-hook call. */
export const contentPublishStatusEnum = pgEnum("content_publish_status", [
  "queued",
  "dispatched",
  "succeeded",
  "failed",
]);

/* ----------------------------------------------------------------- email */

/**
 * What KIND of mail this is. Drives category-scoped unsubscribes: a member who
 * unsubscribes from `fundraising` must still receive `membership` mail about
 * their own renewal, and no send may quietly reclassify itself to escape a
 * suppression.
 */
export const emailCategoryEnum = pgEnum("email_category", [
  "newsletter",
  "policy-alert",
  "event",
  "membership",
  "council",
  "fundraising",
  "general",
]);

/**
 * Campaign lifecycle.
 *
 * The transition into 'sending' is guarded by a CHECK constraint AND a
 * trigger -- see `campaigns` in schema/email.ts and migration 0006. Nothing
 * reaches 'sending' without a named human approver and a live confirmation
 * token.
 */
export const campaignStatusEnum = pgEnum("campaign_status", [
  "draft",
  "ready",
  "scheduled",
  "sending",
  "sent",
  "paused",
  "cancelled",
  "failed",
]);

/** Per-recipient delivery state, driven by provider webhooks. */
export const campaignRecipientStatusEnum = pgEnum("campaign_recipient_status", [
  "pending",
  "sent",
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "unsubscribed",
  "suppressed",
  "failed",
]);

/** Why an address is on the global suppression list. */
export const suppressionReasonEnum = pgEnum("suppression_reason", [
  "unsubscribed",
  "bounced",
  "complained",
  "manual",
]);

/** How wide an unsubscribe link's effect is. */
export const unsubscribeScopeEnum = pgEnum("unsubscribe_scope", [
  "all",
  "category",
]);
