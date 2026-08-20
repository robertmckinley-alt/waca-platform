import { Tabs, type TabItem } from "@/components/ui/tabs";

/**
 * The per-event section strip. Data only — the rendering is the shared
 * <Tabs>, so these look and behave exactly like every other tab strip.
 */
export function EventTabs({ eventId }: { eventId: string }) {
  const base = `/admin/events/${eventId}`;
  const items: TabItem[] = [
    { href: base, label: "Overview", exact: true },
    { href: `${base}/tickets`, label: "Tickets" },
    { href: `${base}/sponsors`, label: "Sponsors" },
    { href: `${base}/registrations`, label: "Registrations" },
    { href: `${base}/checkin`, label: "Check-in" },
    { href: `${base}/clone`, label: "Clone" },
  ];
  return <Tabs items={items} label="Event sections" />;
}
