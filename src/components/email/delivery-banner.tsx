import { deliveryStatus } from "@/lib/email";

/**
 * ============================================================================
 *  THE DRY-RUN BANNER — one component, on every screen that could make a
 *  person believe mail went out.
 *
 *  There were three of these, inline, in three files, with three different
 *  wordings — and the campaign REPORT, the one screen a staffer reads after
 *  pressing send, had none at all. So the report said "3,174 sent" on a
 *  deployment that transmitted nothing, and the only way to find that out was
 *  to notice the absence of replies.
 *
 *  Driven by `deliveryStatus()`, not by the presence of an API key: demo data
 *  and EMAIL_DRY_RUN each force a dry run on their own, and a screen that only
 *  checked the key would stay silent on a staging deployment where a send is a
 *  rehearsal.
 *
 *  IT IS NOT A WARNING, AND IT IS NOT DISMISSIBLE. `role="status"` — a screen
 *  reader hears it when the page is read, not as an alert that interrupts; and
 *  there is no close button, because the condition it describes does not stop
 *  being true when somebody clicks an X.
 * ============================================================================
 */
export function DeliveryModeBanner({
  /** One sentence about what dry run means on THIS screen specifically. */
  context,
  className,
}: {
  context?: string;
  className?: string;
}) {
  const delivery = deliveryStatus();
  if (delivery.transmitting) return null;

  return (
    <p
      role="status"
      className={
        "rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 " +
        (className ?? "mb-4")
      }
    >
      <strong>{delivery.banner}</strong>{" "}
      {context ? `${context} ` : ""}
      {delivery.detail}
    </p>
  );
}

/**
 * The same fact in one line, for a table caption or a stat tile's subtext,
 * where a paragraph would not fit. Returns null when the deployment is live —
 * a live deployment does not need telling.
 */
export function DeliveryModeNote({ className }: { className?: string }) {
  const delivery = deliveryStatus();
  if (delivery.transmitting) return null;
  return (
    <span role="status" className={className ?? "text-[11px] text-amber-800"}>
      Dry run — these counts record what was rendered, not what was delivered.
    </span>
  );
}
