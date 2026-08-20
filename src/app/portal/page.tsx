import Link from "next/link";

import { ActionButton } from "@/components/portal/action-button";
import {
  ActionLink,
  Amount,
  Callout,
  EmptyState,
  Facts,
  PageIntro,
  Pill,
  Row,
  Rows,
  Section,
  statusTone,
} from "@/components/portal/ui";
import { listDocumentsFor, listEvents } from "@/db/queries";
import { DOCUMENT_CATEGORY_LABELS } from "@/lib/documents/labels";
import { documentDownloadHref } from "@/lib/documents/signed-url";
import { formatDateRange, registrationWindowState } from "@/lib/events/format";
import { formatDate, formatDayDelta, humanize } from "@/lib/format";
import { getPortalState } from "@/lib/portal/session";

import { requestRenewalAction } from "./actions";

export const metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

/**
 * THE OVERVIEW.
 *
 * WACA's current member area is a blank page with a logout link. This is the
 * replacement: in one screen, who you are, what you pay for, when it lapses,
 * what you owe, where you are expected next, and what has been published that
 * you can actually read.
 */
export default async function PortalOverview() {
  const state = await getPortalState();

  if (state.status === "no-session") {
    return (
      <EmptyState title="You are not signed in.">
        <p>Your session has expired. Signing in again takes a few seconds.</p>
        <p className="mt-4">
          <ActionLink href="/login?callbackUrl=%2Fportal" variant="primary">
            Sign in
          </ActionLink>
        </p>
      </EmptyState>
    );
  }

  if (state.status !== "ok") {
    const archived = state.status === "archived";
    return (
      <>
        <PageIntro
          eyebrow="Member portal"
          title={archived ? "This login is no longer active" : "Almost there"}
        />
        <EmptyState
          title={
            archived
              ? "Your contact record has been archived."
              : "This login is not linked to a member record yet."
          }
        >
          <p>
            You are signed in as{" "}
            <strong className="font-medium text-zinc-900">{state.email}</strong>,
            but that address is not attached to a WACA contact
            {archived ? " that is still active" : ""}. WACA staff can link it in
            a couple of minutes — this usually happens when someone joins an
            organisation partway through a term, or signs in with a personal
            address rather than the one on the membership.
          </p>
          <p className="mt-4">
            Email{" "}
            <a className="portal-link" href="mailto:info@example.org">
              info@example.org
            </a>{" "}
            with the address you would like used and they will connect it.
          </p>
        </EmptyState>
      </>
    );
  }

  const { context } = state;
  const { contact, organization, membership, balanceDueCents, councils, viewer } =
    context.data;

  const [documents, openEvents] = await Promise.all([
    listDocumentsFor(viewer, { pageSize: 3, sort: "publishedOn", direction: "desc" }),
    listEvents({
      viewer,
      upcomingOnly: true,
      sort: "startsAt",
      direction: "asc",
      pageSize: 12,
    }),
  ]);

  // upcomingRegistrations arrive newest-first; the *next* one is the earliest.
  const nextRegistrations = [...context.data.upcomingRegistrations]
    .filter((r) => r.status !== "cancelled")
    .sort((a, b) => a.eventStartsAt.getTime() - b.eventStartsAt.getTime());
  const nextRegistration = nextRegistrations[0] ?? null;

  const daysUntilExpiry =
    membership?.daysUntilExpiry === null || membership?.daysUntilExpiry === undefined
      ? null
      : Number(membership.daysUntilExpiry);

  const expiringSoon = daysUntilExpiry !== null && daysUntilExpiry <= 60;
  const alreadyExpired = daysUntilExpiry !== null && daysUntilExpiry < 0;
  const needsAttention =
    expiringSoon ||
    membership?.status === "renewal-overdue" ||
    membership?.status === "lapsed";

  // Sponsorship shells are the paired half of a conference — they are sold to
  // sponsors by staff, not browsed by a member looking for something to attend.
  const openToRegister = openEvents.rows
    .filter(
      (event) =>
        event.kind !== "sponsorship" && registrationWindowState(event) === "open",
    )
    .slice(0, 3);

  const openInvoices = context.data.invoices.filter((invoice) =>
    ["sent", "partially-paid", "overdue"].includes(invoice.status),
  );

  return (
    <>
      <PageIntro
        eyebrow={organization?.displayName ?? "WACA membership"}
        title="Your WACA membership"
        lede={
          <>
            Signed in as{" "}
            <strong className="font-medium text-zinc-900">
              {contact.displayName}
            </strong>
            {contact.title ? `, ${contact.title}` : ""}
            {organization ? ` at ${organization.displayName}` : ""}.{" "}
            <Link href="/portal/profile" className="portal-link">
              Update your details
            </Link>
            .
          </>
        }
      />

      {needsAttention && membership ? (
        <div className="mb-12">
          <Callout
            tone={alreadyExpired || membership.status === "lapsed" ? "danger" : "warning"}
            title={
              alreadyExpired
                ? `Your membership expired ${formatDayDelta(daysUntilExpiry)}.`
                : `Your membership expires ${formatDayDelta(daysUntilExpiry)}, on ${formatDate(membership.expiresOn)}.`
            }
            action={
              <ActionButton
                action={requestRenewalAction}
                label="Renew my membership"
                variant="primary"
                description="One click. It sends a renewal request to WACA staff, who confirm the term and email an invoice — cheque, ACH or bank transfer, never a card."
              />
            }
          >
            <p>
              {membership.level.name} ·{" "}
              {membership.autoRenew
                ? "Automatic renewal is on, so WACA will raise the renewal invoice for you. You can still renew early."
                : "Automatic renewal is off for this membership, so nothing happens unless you or WACA staff act."}
            </p>
          </Callout>
        </div>
      ) : null}

      <div className="flex flex-col gap-12">
        <Section
          title="Membership"
          actions={
            <ActionLink href="/portal/membership">
              Level, benefits and renewal history
            </ActionLink>
          }
        >
          {membership ? (
            <Facts
              items={[
                {
                  label: "Level",
                  value: membership.level.name,
                  hint:
                    membership.level.billingPeriod === "monthly"
                      ? "Billed monthly, on the 1st"
                      : "Billed annually, one year from the join date",
                },
                {
                  label: "Status",
                  value: (
                    <Pill tone={statusTone(membership.status)}>
                      {humanize(membership.status)}
                    </Pill>
                  ),
                },
                {
                  label: "Current term",
                  value: `${formatDate(membership.termStartsOn)} — ${formatDate(membership.expiresOn)}`,
                  hint:
                    daysUntilExpiry === null
                      ? undefined
                      : `Expires ${formatDayDelta(daysUntilExpiry)}`,
                },
                {
                  label: "Automatic renewal",
                  value: membership.autoRenew ? (
                    <Pill tone="positive">On</Pill>
                  ) : (
                    <Pill tone="warning">Off</Pill>
                  ),
                  hint: membership.autoRenew
                    ? "WACA raises your renewal invoice at the end of the term."
                    : "Nothing renews on its own. Turn this on from the membership page.",
                },
                {
                  label: "Member since",
                  value: formatDate(membership.joinedOn),
                },
              ]}
            />
          ) : (
            <EmptyState title="No membership is recorded against your organisation.">
              <p>
                Your contact record exists but no current membership term is
                attached to it. If your organisation has paid, this is a
                records problem rather than a lapse — email{" "}
                <a className="portal-link" href="mailto:info@example.org">
                  info@example.org
                </a>{" "}
                and staff will reconcile it.
              </p>
            </EmptyState>
          )}
        </Section>

        <Section
          title="Balance"
          actions={<ActionLink href="/portal/invoices">All invoices</ActionLink>}
        >
          {balanceDueCents > 0 ? (
            <div>
              <p className="font-serif text-[30px] tracking-tight text-zinc-900">
                <Amount cents={balanceDueCents} />
              </p>
              <p className="portal-copy mt-2 text-[14px] text-zinc-600">
                Outstanding across {openInvoices.length}{" "}
                {openInvoices.length === 1 ? "invoice" : "invoices"}. Settle by
                cheque to PO Box 3329, Kirkland WA 98033, or by ACH — the
                remittance details are on each invoice. WACA does not take card
                payments.
              </p>
            </div>
          ) : (
            <EmptyState title="Nothing outstanding.">
              <p>
                Every invoice raised against{" "}
                {organization?.displayName ?? "your record"} has been settled.
                Renewal and event invoices will appear here as they are issued.
              </p>
            </EmptyState>
          )}
        </Section>

        <Section
          title="Your next event"
          actions={
            <ActionLink href="/portal/events">Registrations and history</ActionLink>
          }
        >
          {nextRegistration ? (
            <div>
              <h3 className="font-serif text-[19px] leading-snug text-zinc-900">
                <Link
                  href={`/events/${nextRegistration.eventSlug}`}
                  className="portal-link"
                >
                  {nextRegistration.eventName}
                </Link>
              </h3>
              <p className="mt-1.5 text-[14px] text-zinc-600">
                {formatDateRange(nextRegistration.eventStartsAt, null)} ·{" "}
                {nextRegistration.ticketTypeName}
              </p>
              <p className="mt-3">
                <Pill tone={statusTone(nextRegistration.status)}>
                  {humanize(nextRegistration.status)}
                </Pill>
              </p>
            </div>
          ) : openToRegister.length ? (
            <EmptyState title="You are not registered for anything yet.">
              <p>
                {openToRegister.length === 1
                  ? "One event is open to you right now:"
                  : "These are open to you right now:"}
              </p>
              <ul className="mt-3 flex flex-col gap-1">
                {openToRegister.map((event) => (
                  <li key={event.id}>
                    <Link href={`/events/${event.slug}`} className="portal-link">
                      {event.name}
                    </Link>{" "}
                    <span className="text-zinc-500">
                      — {formatDateRange(event.startsAt, event.endsAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </EmptyState>
          ) : (
            <EmptyState title="Nothing on the calendar yet.">
              <p>
                WACA runs conferences, Day on the Hill, sector council meetings
                and webinars through the year. When the next one opens for
                registration it will appear here and in{" "}
                <Link href="/portal/events" className="portal-link">
                  your events
                </Link>
                .
              </p>
            </EmptyState>
          )}
        </Section>

        <Section
          title="Latest from the library"
          description="The three most recent documents you have access to. The weekly legislative Detail Reports live here."
          actions={<ActionLink href="/portal/library">Search the library</ActionLink>}
        >
          {documents.rows.length ? (
            <Rows>
              {documents.rows.map((doc) => (
                <Row key={doc.id}>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                    <h3 className="text-[15px] font-medium text-zinc-900">
                      {doc.title}
                    </h3>
                    <p className="text-[13px] text-zinc-500">
                      {formatDate(doc.publishedOn)}
                    </p>
                  </div>
                  <p className="mt-1 text-[13px] text-zinc-500">
                    {DOCUMENT_CATEGORY_LABELS[doc.category] ?? humanize(doc.category)}
                  </p>
                  <p className="mt-2">
                    <ActionLink
                      href={documentDownloadHref(doc.id, viewer.contactId)}
                      download
                    >
                      Download
                    </ActionLink>
                  </p>
                </Row>
              ))}
            </Rows>
          ) : (
            <EmptyState title="Nothing published to you yet.">
              <p>
                Documents are released by scope — public, all members, specific
                membership levels, or a sector council. Once your membership is
                active the weekly Detail Reports and the legislative agendas
                appear here.
              </p>
            </EmptyState>
          )}
        </Section>

        {councils.length ? (
          <Section
            title="Your sector councils"
            actions={<ActionLink href="/portal/councils">Council rosters</ActionLink>}
          >
            <Rows>
              {councils.map((council) => (
                <Row key={council.councilId}>
                  <Link
                    href={`/portal/councils/${council.slug}`}
                    className="portal-link text-[15px] font-medium"
                  >
                    {council.name}
                  </Link>
                  <p className="mt-1 text-[13px] text-zinc-500">
                    {humanize(council.role)}
                    {council.autoEnrolled
                      ? " · enrolled automatically from your licence types"
                      : ""}
                  </p>
                </Row>
              ))}
            </Rows>
          </Section>
        ) : null}
      </div>
    </>
  );
}
