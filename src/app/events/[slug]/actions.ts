"use server";

import { redirect } from "next/navigation";
import { fail, formToObject, invalid, type ActionState } from "@/lib/action-state";
import { publicRegistrationSchema } from "@/lib/events/schemas";
import { RegistrationError, registerForEvent } from "@/lib/events/registration";
import { getViewer } from "@/lib/viewer";

/**
 * Public/member registration submit.
 *
 * The event is resolved through the visibility gate inside registerForEvent,
 * so posting a guessed event id for a non-public fundraiser fails as "not
 * found" — the same answer an anonymous GET gets.
 */
export async function submitRegistrationAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = publicRegistrationSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);

  const viewer = await getViewer();

  let destination: string;
  try {
    const outcome = await registerForEvent(parsed.data, viewer);
    const query = new URLSearchParams({
      confirmed: String(outcome.confirmedCount),
      waitlisted: String(outcome.waitlistedCount),
    });
    if (outcome.invoice) query.set("invoice", outcome.invoice.number);
    destination = `/events/${outcome.eventSlug}/confirmed?${query.toString()}`;
  } catch (error) {
    if (error instanceof RegistrationError) return fail(error.message);
    console.error("[events] registration failed", error);
    return fail(
      "Something went wrong creating that registration. Please try again, or email the events team.",
    );
  }

  // Outside the try: redirect() signals by throwing.
  redirect(destination);
}
