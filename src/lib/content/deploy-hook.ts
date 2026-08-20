/**
 * ============================================================================
 *  THE VERCEL DEPLOY HOOK.
 *
 *  Publishing writes rows; the public site is static, so it only changes when
 *  something rebuilds it. That something is a POST to a Vercel Deploy Hook.
 *
 *  THREE RULES, all of which the schema already assumes:
 *
 *  1. THE URL IS A CREDENTIAL. Anyone who has it can trigger unlimited builds
 *     on WACA's account. It is read from the environment at the moment of the
 *     call and is never stored, never logged, never returned to the browser,
 *     and never written into content_publishes. Only the status, the response
 *     body and the resulting deployment URL are recorded.
 *
 *  2. ITS ABSENCE IS NOT AN ERROR. There is no hook in development and there
 *     will be none until the Vercel project is wired up. A publish with no
 *     hook configured is a successful publish that has not been deployed —
 *     the rows are correct, the API serves the new snapshot immediately, and
 *     the site picks it up on its next build. Throwing here would make the
 *     whole CMS unusable locally to no purpose.
 *
 *  3. IT IS FIRED AFTER THE TRANSACTION COMMITS. Not by this module — by the
 *     server action, which calls publishItems(), lets it commit, calls this,
 *     then calls recordPublishDispatch(). Firing inside the transaction would
 *     let a rebuild start against data that then rolls back.
 * ============================================================================
 */

export type DeployHookResult =
  | { fired: false; reason: "not-configured" }
  | {
      fired: true;
      ok: boolean;
      status: number;
      /** Verbatim response body, parsed when it is JSON. Never the URL. */
      response: Record<string, unknown>;
      deploymentId: string | null;
      deploymentUrl: string | null;
      error: string | null;
    };

export function deployHookConfigured(): boolean {
  return Boolean(process.env.VERCEL_DEPLOY_HOOK_URL?.trim());
}

/**
 * Vercel answers a deploy hook with `{ job: { id, state, createdAt, ... } }`.
 * The deployment URL is not in that response — the job has not produced one
 * yet — so `deploymentUrl` is usually null and the publish log links to the
 * project's deployments page instead of promising a URL that does not exist.
 */
export async function fireDeployHook(): Promise<DeployHookResult> {
  const url = process.env.VERCEL_DEPLOY_HOOK_URL?.trim();
  if (!url) return { fired: false, reason: "not-configured" };

  try {
    const res = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    const raw = await res.text().catch(() => "");
    let response: Record<string, unknown> = {};
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        response =
          parsed && typeof parsed === "object"
            ? (parsed as Record<string, unknown>)
            : { body: raw.slice(0, 2000) };
      } catch {
        response = { body: raw.slice(0, 2000) };
      }
    }

    const job = response.job as Record<string, unknown> | undefined;

    return {
      fired: true,
      ok: res.ok,
      status: res.status,
      response,
      deploymentId:
        typeof job?.id === "string"
          ? job.id
          : typeof response.id === "string"
            ? response.id
            : null,
      deploymentUrl:
        typeof response.url === "string" ? `https://${response.url}` : null,
      error: res.ok ? null : `Deploy hook returned HTTP ${res.status}.`,
    };
  } catch (error) {
    // The message is logged, not the URL: a fetch failure can include the
    // request target in its message, and that target is the credential.
    console.error(
      "[content] deploy hook failed",
      error instanceof Error ? error.name : "unknown-error",
    );
    return {
      fired: true,
      ok: false,
      status: 0,
      response: {},
      deploymentId: null,
      deploymentUrl: null,
      error:
        "Could not reach the deploy hook. The content is published; the site " +
        "has not been rebuilt. Retry from the publish log.",
    };
  }
}
