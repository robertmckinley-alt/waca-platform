import { and, asc, eq } from "drizzle-orm";

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
import { db } from "@/db";
import { getMemberDetail } from "@/db/queries";
import { membershipLevels } from "@/db/schema";
import { formatCents, formatDate, formatDayDelta, humanize } from "@/lib/format";
import { requirePortal } from "@/lib/portal/session";

import { requestRenewalAction, setAutoRenewAction } from "../actions";
import { LevelChangeForm, type LevelOption } from "./level-change-form";

export const metadata = { title: "Membership" };
export const dynamic = "force-dynamic";

const OPEN_APPLICATION = new Set(["submitted", "under-review"]);

function eligibilityLabel(level: {
  revenueBandMinCents: number | null;
  revenueBandMaxCents: number | null;
}): string | null {
  const { revenueBandMinCents: min, revenueBandMaxCents: max } = level;
  if (min == null && max == null) return null;
  if (min != null && max != null)
    return `annual revenue ${formatCents(min)}–${formatCents(max)}`;
  if (min != null) return `annual revenue over ${formatCents(min)}`;
  return `annual revenue under ${formatCents(max!)}`;
}

export default async function MembershipPage() {
  const context = await requirePortal();
  const { organization, membership, contact } = context.data;

  if (!organization || !membership) {
    return (
      <>
        <PageIntro eyebrow="Membership" title="Your membership" />
        <EmptyState title="No current membership is recorded.">
          <p>
            Your contact record is not attached to an organisation holding a
            membership term. If your organisation has paid, this is a records
            problem rather than a lapse — email{" "}
            <a className="portal-link" href="mailto:info@example.org">
              info@example.org
            </a>{" "}
            and WACA staff will reconcile it.
          </p>
        </EmptyState>
      </>
    );
  }

  const [detail, levelRows] = await Promise.all([
    getMemberDetail(organization.id),
    db
      .select()
      .from(membershipLevels)
      .where(
        and(
          eq(membershipLevels.isActive, true),
          eq(membershipLevels.publicApplications, true),
        ),
      )
      .orderBy(asc(membershipLevels.sortOrder)),
  ]);

  const levels: LevelOption[] = levelRows.map((level) => ({
    id: level.id,
    name: level.name,
    feeLabel: `${formatCents(level.feeCents)}${level.billingPeriod === "monthly" ? "/month" : "/year"}`,
    eligibility: eligibilityLabel(level),
  }));

  const history = (detail?.membershipHistory ?? []).filter(
    (row) => row.id !== membership.id,
  );
  const openApplications = (detail?.applications ?? []).filter((a) =>
    OPEN_APPLICATION.has(a.status),
  );

  const daysUntilExpiry =
    membership.daysUntilExpiry === null || membership.daysUntilExpiry === undefined
      ? null
      : Number(membership.daysUntilExpiry);

  const benefits = membership.level.benefits ?? [];
  const canManage = contact.isBundleAdmin || contact.isPrimaryContact;

  return (
    <>
      <PageIntro
        eyebrow={organization.displayName}
        title={membership.level.name}
        lede={
          <>
            {formatCents(membership.level.feeCents)}
            {membership.level.billingPeriod === "monthly" ? " per month" : " per year"}
            {membership.level.description ? ` · ${membership.level.description}` : ""}
          </>
        }
      />

      {openApplications.length ? (
        <div className="mb-12">
          <Callout tone="positive" title="A request is with WACA staff">
            <p>
              {openApplications
                .map(
                  (application) =>
                    `${humanize(application.type)} request, submitted ${formatDate(application.submittedAt)} (${humanize(application.status)})`,
                )
                .join("; ")}
              . Staff will confirm and email the invoice. Nothing changes on
              your membership until they approve it.
            </p>
          </Callout>
        </div>
      ) : null}

      <div className="flex flex-col gap-12">
        <Section title="Term">
          <Facts
            items={[
              {
                label: "Status",
                value: (
                  <Pill tone={statusTone(membership.status)}>
                    {humanize(membership.status)}
                  </Pill>
                ),
              },
              { label: "Joined", value: formatDate(membership.joinedOn) },
              {
                label: "Current term",
                value: `${formatDate(membership.termStartsOn)} — ${formatDate(membership.expiresOn)}`,
                hint:
                  daysUntilExpiry === null
                    ? undefined
                    : `Expires ${formatDayDelta(daysUntilExpiry)}`,
              },
              {
                label: "Fee for this term",
                value: <Amount cents={membership.feeChargedCents} />,
                hint:
                  membership.feeChargedCents !== null &&
                  membership.feeChargedCents !== membership.level.feeCents
                    ? `List price for this level is ${formatCents(membership.level.feeCents)}`
                    : undefined,
              },
              {
                label: "Renewal basis",
                value:
                  membership.level.renewalAnchor === "join_date"
                    ? "One year from the join date"
                    : `Calendar${membership.level.billingPeriod === "monthly" ? " month, on the 1st" : " year"}`,
              },
              {
                label: "Reminders sent",
                value: membership.renewalRemindersSent
                  ? `${membership.renewalRemindersSent}${membership.lastReminderSentAt ? `, last on ${formatDate(membership.lastReminderSentAt)}` : ""}`
                  : "None yet",
                hint: "WACA emails the renewal ladder at 60, 30 and 7 days before expiry, then 7 and 30 days after.",
              },
            ]}
          />
        </Section>

        <Section
          title="Automatic renewal"
          description={
            membership.autoRenew
              ? "On. WACA raises your renewal invoice at the end of the term so the membership does not lapse by accident. You still settle it offline, by cheque or bank transfer."
              : "Off. Nothing renews on its own — if nobody acts before the expiry date the membership lapses, and with it the library and members-only events."
          }
        >
          <div className="flex flex-wrap items-start gap-8">
            <p>
              {membership.autoRenew ? (
                <Pill tone="positive">On for this membership</Pill>
              ) : (
                <Pill tone="warning">Off for this membership</Pill>
              )}
            </p>
            {canManage ? (
              <ActionButton
                action={setAutoRenewAction}
                label={membership.autoRenew ? "Turn automatic renewal off" : "Turn automatic renewal on"}
                variant={membership.autoRenew ? "outline" : "primary"}
                fields={{ autoRenew: membership.autoRenew ? "off" : "on" }}
                description={
                  membership.autoRenew
                    ? "You will keep getting reminders before expiry."
                    : "This raises the invoice automatically. It never takes a payment — WACA does not process cards."
                }
              />
            ) : (
              <p className="portal-copy text-[14px] text-zinc-600">
                Your bundle administrator or primary contact controls this
                setting for {organization.displayName}.
              </p>
            )}
          </div>
        </Section>

        <Section
          title="Renew"
          description="Renewing sends a request to WACA staff, who confirm your term and raise the invoice."
        >
          {openApplications.length ? (
            <p className="portal-copy text-[14px] text-zinc-600">
              A request is already open — see above. There is nothing else to
              send.
            </p>
          ) : (
            <ActionButton
              action={requestRenewalAction}
              label="Renew my membership"
              variant="primary"
              description={`Renews ${organization.displayName} on ${membership.level.name}. Settled offline by cheque, ACH or bank transfer.`}
            />
          )}
        </Section>

        <Section
          title="What this level includes"
          description={
            benefits.length
              ? undefined
              : "Benefits for this level have not been written up in the platform yet."
          }
        >
          {benefits.length ? (
            <ul className="portal-copy flex flex-col gap-2 text-[15px] text-zinc-700">
              {benefits.map((benefit) => (
                <li key={benefit} className="flex gap-3">
                  <span aria-hidden className="pt-2 text-zinc-300">
                    —
                  </span>
                  <span>{benefit}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="Benefits are not listed here yet.">
              <p>
                Every WACA membership carries the legislative Detail Reports,
                the sector councils, member rates at events and direct access to
                the advocacy team. The itemised list for {membership.level.name}{" "}
                will appear here once staff publish it.
              </p>
            </EmptyState>
          )}
        </Section>

        <Section
          title="Change level"
          description="Levels are set by annual revenue band. Ask for a different one and staff will check eligibility."
        >
          {canManage ? (
            <LevelChangeForm levels={levels} currentLevelId={membership.levelId} />
          ) : (
            <p className="portal-copy text-[14px] text-zinc-600">
              Level changes are requested by your bundle administrator or
              primary contact. If {organization.displayName} has moved revenue
              band, speak to them or email{" "}
              <a className="portal-link" href="mailto:info@example.org">
                info@example.org
              </a>
              .
            </p>
          )}
        </Section>

        <Section
          title="Renewal history"
          actions={<ActionLink href="/portal/invoices">Invoices</ActionLink>}
        >
          {history.length ? (
            <Rows>
              {history.map((term) => (
                <Row key={term.id}>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                    <p className="text-[15px] text-zinc-900">{term.levelName}</p>
                    <p className="tabular text-[13px] text-zinc-500">
                      {formatDate(term.termStartsOn)} — {formatDate(term.expiresOn)}
                    </p>
                  </div>
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-zinc-500">
                    <Pill tone={statusTone(term.status)}>{humanize(term.status)}</Pill>
                    {term.feeChargedCents ? (
                      <span>
                        <Amount cents={term.feeChargedCents} /> charged
                      </span>
                    ) : null}
                    {term.lapsedOn ? <span>Lapsed {formatDate(term.lapsedOn)}</span> : null}
                  </p>
                </Row>
              ))}
            </Rows>
          ) : (
            <EmptyState title="This is your first term.">
              <p>
                {organization.displayName} joined WACA on{" "}
                {formatDate(membership.joinedOn)}. Once you renew, each past
                term appears here with the level you held and what was charged.
              </p>
            </EmptyState>
          )}
        </Section>
      </div>
    </>
  );
}
