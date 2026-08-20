"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { z } from "zod";

import { signIn, signOut } from "@/auth";
import { fail, formToObject, invalid, type ActionState } from "@/lib/action-state";

/**
 * Sign-in actions.
 *
 * Two ways in, both Auth.js v5:
 *   · magic link (Resend) — the primary path. Members do not have passwords
 *     and should not need one.
 *   · email + password — secondary, for staff and members who set one.
 *
 * Neither branch ever says whether an address is on file. "Check your email"
 * and "those details did not match" are returned regardless, so the form is
 * not an account-enumeration oracle.
 */

/** Only same-origin paths. Blocks `//evil.example` and absolute URLs. */
function safeCallback(raw: unknown): string {
  const value = typeof raw === "string" ? raw : "";
  if (!value.startsWith("/") || value.startsWith("//")) return "/portal";
  return value;
}

const emailSchema = z.object({
  email: z.string().trim().min(1, "Enter your email address").pipe(z.email()),
  callbackUrl: z.string().optional(),
});

const passwordSchema = z.object({
  email: z.string().trim().min(1, "Enter your email address").pipe(z.email()),
  password: z.string().min(1, "Enter your password"),
  callbackUrl: z.string().optional(),
});

export async function magicLinkAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = emailSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);

  const callbackUrl = safeCallback(parsed.data.callbackUrl);

  if (!(process.env.AUTH_RESEND_KEY || process.env.RESEND_API_KEY)) {
    // Honest failure rather than a silent one: this environment has no Resend
    // key, so no link can be sent. Production sets AUTH_RESEND_KEY.
    return fail(
      "Magic-link email is not configured in this environment. Sign in with a password below, or contact WACA staff.",
    );
  }

  try {
    await signIn("resend", {
      email: parsed.data.email,
      redirect: false,
      redirectTo: callbackUrl,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      console.error("[auth] magic link failed", error.type);
      return fail(
        "We could not send that link just now. Try again in a moment, or sign in with a password.",
      );
    }
    throw error;
  }

  redirect(
    `/login/check-email?email=${encodeURIComponent(parsed.data.email)}`,
  );
}

export async function passwordAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = passwordSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);

  const callbackUrl = safeCallback(parsed.data.callbackUrl);

  try {
    await signIn("credentials", {
      email: parsed.data.email,
      password: parsed.data.password,
      redirectTo: callbackUrl,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      // Same message for "no such user", "wrong password" and "deactivated".
      return fail("Those details did not match an active WACA account.");
    }
    // redirect() signals by throwing — let it through.
    throw error;
  }

  return { status: "idle" };
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/login?signedOut=1" });
}
