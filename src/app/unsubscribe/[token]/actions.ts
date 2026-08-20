"use server";

import { redirect } from "next/navigation";
import { redeemUnsubscribe, undoUnsubscribe } from "@/lib/email";

/**
 * The two writes behind the unsubscribe page. Both are POST-only server
 * actions, which is the whole point: a GET must never change anybody's
 * subscription, because corporate link scanners issue GETs for every URL in
 * every message and would otherwise empty WACA's list without a human
 * involved. See src/lib/email/unsubscribe.ts.
 *
 * Neither action returns anything about the contact. They redirect back to
 * the same page with a flag, and the page re-reads the token's state through
 * `peek`, which only ever discloses a masked address.
 */

function tokenFrom(formData: FormData): string {
  const raw = formData.get("token");
  return typeof raw === "string" ? raw : "";
}

export async function unsubscribeAction(formData: FormData): Promise<void> {
  const token = tokenFrom(formData);
  const result = await redeemUnsubscribe(token);
  redirect(
    `/unsubscribe/${encodeURIComponent(token)}?${result.ok ? "done=1" : "error=1"}`,
  );
}

export async function undoUnsubscribeAction(formData: FormData): Promise<void> {
  const token = tokenFrom(formData);
  const result = await undoUnsubscribe(token);
  redirect(
    `/unsubscribe/${encodeURIComponent(token)}?${
      result.ok ? "undone=1" : `undo-failed=${result.reason ?? "unknown"}`
    }`,
  );
}
