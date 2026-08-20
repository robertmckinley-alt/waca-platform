import type { NextRequest } from "next/server";
import { authoriseCron } from "@/lib/cron-auth";
import { db } from "@/db";
import {
  applyContentSchedule,
  publishItems,
  recordPublishDispatch,
} from "@/db/queries";
import { recordAudit } from "@/lib/audit";
import { fireDeployHook } from "@/lib/content/deploy-hook";

/**
 * ===========================================================================
 *  THE SCHEDULED-PUBLISH SWEEP.   GET /api/cron/content
 *
 *  Publishes items whose publish_at has passed, takes down items whose
 *  unpublish_at has passed, and — only if something actually moved — fires
 *  ONE deploy hook for the whole batch.
 *
 *  Firing per item would queue eleven Vercel builds for an agenda with eleven
 *  attachments. One batch, one build.
 *
 *  BELT AND BRACES: /api/content/* already applies publish_at and
 *  unpublish_at when it selects, so an item scheduled for next Tuesday cannot
 *  appear in a build that happens to run before this sweep does. The sweep
 *  exists to change the item's STATUS (so staff see the right thing in the
 *  CMS) and to trigger the rebuild. If the cron never runs, nothing is
 *  published early and nothing is published late by more than one build.
 *
 *  Guarded by CRON_SECRET, compared in constant time, with the same
 *  refuse-if-unset posture as the renewal cron: an open endpoint that changes
 *  what is on a public website is not acceptable in development either.
 * ===========================================================================
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const SYSTEM_ACTOR = {
  userId: null,
  label: "Scheduled publish (cron)",
} as const;

export async function GET(request: NextRequest) {
  const denied = authoriseCron(request, "content", "changes what is on the public website");
  if (denied) return denied;

  const dryRun = request.nextUrl.searchParams.get("dryRun") === "1";
  const startedAt = Date.now();

  if (dryRun) {
    // Nothing to report without doing the work; say so rather than pretending.
    return Response.json({
      ok: true,
      dryRun: true,
      note: "This sweep has no dry-run mode. Read /admin/content/publish for what is queued.",
    });
  }

  const swept = await applyContentSchedule();
  const moved = swept.published.length + swept.unpublished.length;

  let publishId: string | null = null;
  let deployment: Record<string, unknown> = { fired: false };

  if (moved > 0) {
    // Record the run so the publish log shows scheduled publishes beside the
    // ones a human pressed. applyContentSchedule() has already promoted the
    // revisions; publishItems() is idempotent over them and gives us the
    // content_publishes row.
    const run = await db.transaction(async (tx) => {
      const result = swept.published.length
        ? await publishItems({
            db: tx,
            itemIds: swept.published,
            note: "Scheduled publish",
            actor: SYSTEM_ACTOR,
          })
        : null;

      await recordAudit({
        db: tx,
        actor: SYSTEM_ACTOR,
        action: "status-change",
        entity: "content_items",
        after: {
          published: swept.published.length,
          unpublished: swept.unpublished.length,
        },
        metadata: {
          module: "content",
          source: "cron",
          publishedIds: swept.published,
          unpublishedIds: swept.unpublished,
        },
      });

      return result;
    });

    publishId = run?.publishId ?? null;

    const hook = await fireDeployHook();
    if (publishId) {
      await recordPublishDispatch({
        publishId,
        status: !hook.fired ? "succeeded" : hook.ok ? "succeeded" : "failed",
        deployHookStatus: hook.fired ? hook.status : null,
        deployHookResponse: hook.fired
          ? hook.response
          : { note: "VERCEL_DEPLOY_HOOK_URL is not set." },
        deploymentId: hook.fired ? hook.deploymentId : null,
        deploymentUrl: hook.fired ? hook.deploymentUrl : null,
        error: hook.fired ? hook.error : null,
      });
    }
    deployment = hook.fired
      ? { fired: true, ok: hook.ok, status: hook.status }
      : { fired: false, reason: "VERCEL_DEPLOY_HOOK_URL is not set." };
  }

  return Response.json({
    ok: true,
    tookMs: Date.now() - startedAt,
    published: swept.published.length,
    unpublished: swept.unpublished.length,
    publishId,
    deployment,
  });
}
