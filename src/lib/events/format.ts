import type { EventKind, EventVisibility } from "@/db/queries";

/**
 * Event-specific formatting. Money and plain dates come from @/lib/format —
 * this file only adds what the events module needs on top, so there is one
 * money formatter in the codebase, not two.
 */
export {
  formatCents,
  formatCentsCompact,
  formatDate,
  formatDateTime,
  humanize,
  percent,
} from "@/lib/format";

const TZ = "America/Los_Angeles";

const dayFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: TZ,
});

const timeFmt = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: TZ,
});

const dayKeyFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  dateStyle: "short",
});

export function formatEventTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = new Date(d);
  return Number.isNaN(date.getTime()) ? "—" : timeFmt.format(date);
}

/** "Mar 3, 2026 – Mar 5, 2026" for a multi-day event, one date otherwise. */
export function formatDateRange(
  startsAt: Date | string,
  endsAt: Date | string | null | undefined,
): string {
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) return "—";
  if (!endsAt) return dayFmt.format(start);
  const end = new Date(endsAt);
  if (Number.isNaN(end.getTime())) return dayFmt.format(start);
  if (dayKeyFmt.format(start) === dayKeyFmt.format(end)) {
    return `${dayFmt.format(start)}, ${timeFmt.format(start)}–${timeFmt.format(end)}`;
  }
  return `${dayFmt.format(start)} – ${dayFmt.format(end)}`;
}

export function isMultiDay(
  startsAt: Date | string,
  endsAt: Date | string | null | undefined,
): boolean {
  if (!endsAt) return false;
  return dayKeyFmt.format(new Date(startsAt)) !== dayKeyFmt.format(new Date(endsAt));
}

/** Value for `<input type="datetime-local">`, in local wall-clock terms. */
export function toDateTimeLocal(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 0.78 -> "78%". Null-safe; the events module reports attendance a lot. */
export function formatRate(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

export const EVENT_KIND_LABELS: Record<EventKind, string> = {
  conference: "Conference",
  "day-on-the-hill": "Day on the Hill",
  "sector-council": "Sector council",
  "member-meeting": "Member meeting",
  fundraiser: "Fundraiser",
  webinar: "Webinar",
  workshop: "Workshop",
  sponsorship: "Sponsorship",
};

export const EVENT_KINDS = Object.keys(EVENT_KIND_LABELS) as EventKind[];

export const EVENT_VISIBILITY_LABELS: Record<EventVisibility, string> = {
  public: "Public",
  "members-only": "Members only",
  "invite-only": "Invite only",
  "admin-only": "Admin only",
};

export const EVENT_VISIBILITIES = Object.keys(
  EVENT_VISIBILITY_LABELS,
) as EventVisibility[];

export const EVENT_STATUSES = [
  "draft",
  "published",
  "cancelled",
  "completed",
] as const;

export const REGISTRATION_STATUSES = [
  "pending",
  "confirmed",
  "waitlisted",
  "cancelled",
] as const;

export type RegistrationWindowState = "open" | "not-yet-open" | "closed";

/**
 * Is registration open right now? Presentational twin of
 * assertRegistrationOpen() in registration.ts — that one is authoritative.
 */
export function registrationWindowState(e: {
  status: string;
  registrationOpensAt: Date | string | null;
  registrationClosesAt: Date | string | null;
  startsAt: Date | string;
}): RegistrationWindowState {
  const now = Date.now();
  if (e.status !== "published") return "closed";
  if (e.registrationOpensAt && new Date(e.registrationOpensAt).getTime() > now)
    return "not-yet-open";
  const closesAt = e.registrationClosesAt ?? e.startsAt;
  if (closesAt && new Date(closesAt).getTime() < now) return "closed";
  return "open";
}

export const REGISTRATION_WINDOW_LABELS: Record<RegistrationWindowState, string> = {
  open: "Open",
  "not-yet-open": "Not yet open",
  closed: "Closed",
};

/** The tag column in the admin list, mirroring Wild Apricot's event tags. */
export function eventTags(e: {
  kind: EventKind;
  isVirtual: boolean;
  capacity: number | null;
  registeredCount: number;
  pairedSponsorshipEventId: string | null;
  councilId: string | null;
  waitlistEnabled?: boolean;
}): string[] {
  const tags: string[] = [EVENT_KIND_LABELS[e.kind]];
  if (e.isVirtual) tags.push("Virtual");
  if (e.pairedSponsorshipEventId) tags.push("Paired sponsorship");
  if (e.councilId) tags.push("Council");
  if (e.capacity != null && e.registeredCount >= e.capacity) tags.push("At capacity");
  if (e.waitlistEnabled) tags.push("Waitlist");
  return tags;
}
