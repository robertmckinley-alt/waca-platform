/**
 * ===========================================================================
 *  THE EMAIL COMPOSER'S LIBRARY — one import path.
 *
 *      import { renderCampaign, runReview, MERGE_FIELDS } from "@/lib/email/campaign";
 *
 *  WHAT LIVES HERE: everything up to the moment of sending — the block model,
 *  the two renderers, merge fields, CAN-SPAM, and the review gate.
 *
 *  WHAT DOES NOT: dispatch, provider webhooks, and the suppression reducer.
 *  Those belong to the delivery module and are reached through
 *  @/lib/email/client (the one send path) and @/db/queries/email (the one
 *  place a campaign moves to 'sending'). Nothing in this directory sends
 *  anything to a list.
 * ===========================================================================
 */

export * from "./blocks";
export * from "./merge";
export * from "./render";
export * from "./compliance";
export * from "./checklist";
export * from "./labels";
