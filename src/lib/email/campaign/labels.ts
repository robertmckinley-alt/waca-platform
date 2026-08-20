import {
  campaignRecipientStatusEnum,
  campaignStatusEnum,
  emailCategoryEnum,
  suppressionReasonEnum,
} from "@/db/schema/enums";
import type {
  CampaignStatus,
  EmailCategory,
  RecipientStatus,
  SuppressionReason,
} from "@/db/queries";

/**
 * The vocabularies, DERIVED FROM THE ENUMS rather than retyped. A hand-written
 * copy of a Postgres enum is a list that is correct until somebody adds a
 * value, and then is wrong in exactly one screen nobody looks at.
 */
export const EMAIL_CATEGORIES = emailCategoryEnum.enumValues as readonly EmailCategory[];
export const CAMPAIGN_STATUSES = campaignStatusEnum.enumValues as readonly CampaignStatus[];
export const RECIPIENT_STATUSES =
  campaignRecipientStatusEnum.enumValues as readonly RecipientStatus[];
export const SUPPRESSION_REASONS =
  suppressionReasonEnum.enumValues as readonly SuppressionReason[];

export const CATEGORY_LABELS: Record<EmailCategory, string> = {
  newsletter: "Newsletter",
  "policy-alert": "Policy alert",
  event: "Event",
  membership: "Membership",
  council: "Sector council",
  fundraising: "Fundraising",
  general: "General",
};

/**
 * What a category-scoped unsubscribe actually means, in the words a staffer
 * needs when choosing one. Category is immutable after a campaign leaves
 * draft, so this choice has consequences.
 */
export const CATEGORY_HINTS: Record<EmailCategory, string> = {
  newsletter: "The regular member newsletter. Most of the list expects this one.",
  "policy-alert": "Legislative and regulatory alerts. Time-sensitive.",
  event: "Event invitations, reminders and follow-ups.",
  membership: "Joining, renewing, and membership benefits.",
  council: "Sector council business — agendas, minutes, seats.",
  fundraising: "Asks. Legislator and congressional fundraisers.",
  general: "Anything that is not one of the above.",
};

export const STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: "Draft",
  ready: "Ready to send",
  scheduled: "Scheduled",
  sending: "Sending",
  sent: "Sent",
  paused: "Paused",
  cancelled: "Cancelled",
  failed: "Failed",
};

export type Tone = "neutral" | "positive" | "warning" | "danger" | "muted";

export const STATUS_TONE: Record<CampaignStatus, Tone> = {
  draft: "muted",
  ready: "neutral",
  scheduled: "warning",
  sending: "warning",
  sent: "positive",
  paused: "warning",
  cancelled: "muted",
  failed: "danger",
};

export const RECIPIENT_STATUS_TONE: Record<RecipientStatus, Tone> = {
  pending: "muted",
  sent: "neutral",
  delivered: "neutral",
  opened: "positive",
  clicked: "positive",
  bounced: "danger",
  complained: "danger",
  unsubscribed: "warning",
  suppressed: "muted",
  failed: "danger",
};

export const SUPPRESSION_REASON_LABELS: Record<SuppressionReason, string> = {
  unsubscribed: "Unsubscribed",
  bounced: "Bounced",
  complained: "Marked as spam",
  manual: "Added by staff",
};

export const SUPPRESSION_REASON_HINTS: Record<SuppressionReason, string> = {
  unsubscribed:
    "They used an unsubscribe link. Removing this address means mailing somebody who asked you not to.",
  bounced:
    "The provider could not deliver. Continuing to mail a bouncing address damages WACA's sending reputation for everybody else on the list.",
  complained:
    "They pressed the spam button. This is the most damaging signal a mailbox provider records.",
  manual: "A staff member added it by hand.",
};

export const SUPPRESSION_REASON_TONE: Record<SuppressionReason, Tone> = {
  unsubscribed: "warning",
  bounced: "danger",
  complained: "danger",
  manual: "neutral",
};

/** Statuses a campaign can still be edited in. Mirrors the trigger's view. */
export const EDITABLE_STATUSES: readonly CampaignStatus[] = [
  "draft",
  "ready",
  "scheduled",
  "failed",
];

export function isEditable(status: CampaignStatus): boolean {
  return EDITABLE_STATUSES.includes(status);
}

/** Rate as a percentage string, or an em dash when there is no denominator. */
export function rate(numerator: number, denominator: number): string {
  if (!denominator) return "—";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

export const count = (v: number | null | undefined): string =>
  (v ?? 0).toLocaleString("en-US");
