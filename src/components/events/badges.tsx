import { Badge } from "@/components/ui/primitives";
import {
  EVENT_VISIBILITY_LABELS,
  humanize,
} from "@/lib/events/format";
import type { EventVisibility } from "@/db/queries";

/**
 * Visibility is the field that decides whether an event can leak, so it gets
 * a loud badge: admin-only reads as danger, invite-only as warning, and only
 * `public` is unadorned.
 */
export function EventVisibilityBadge({
  visibility,
}: {
  visibility: EventVisibility;
}) {
  const tone =
    visibility === "admin-only"
      ? "danger"
      : visibility === "invite-only"
        ? "warning"
        : visibility === "members-only"
          ? "muted"
          : "neutral";
  return <Badge tone={tone}>{EVENT_VISIBILITY_LABELS[visibility]}</Badge>;
}

export function RegistrationStatusBadge({ status }: { status: string }) {
  const tone =
    status === "confirmed"
      ? "positive"
      : status === "pending"
        ? "warning"
        : status === "waitlisted"
          ? "neutral"
          : "muted";
  return <Badge tone={tone}>{humanize(status)}</Badge>;
}
