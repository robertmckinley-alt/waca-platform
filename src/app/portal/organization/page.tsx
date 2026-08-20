import { and, asc, eq, isNull } from "drizzle-orm";

import { ActionButton } from "@/components/portal/action-button";
import {
  EmptyState,
  Facts,
  PageIntro,
  Pill,
  Row,
  Rows,
  Section,
} from "@/components/portal/ui";
import { db } from "@/db";
import { contacts } from "@/db/schema";
import { formatDate, humanize } from "@/lib/format";
import { requireBundleAdmin } from "@/lib/portal/session";

import { AddContactForm } from "./add-contact-form";
import {
  removeBundleContactAction,
  setBundleAdminAction,
  setPrimaryContactAction,
} from "./actions";

export const metadata = { title: "Your organisation" };
export const dynamic = "force-dynamic";

/**
 * BUNDLE MANAGEMENT — bundle administrators only.
 *
 * requireBundleAdmin() redirects anyone else back to the overview rather than
 * rendering a 403, so the route's existence is not advertised. The actions on
 * this page each re-check the same gate.
 *
 * A WACA bundle can run to 21 contacts. Today they are maintained by emailing
 * staff; this is the page that stops that.
 */
export default async function OrganizationPage() {
  const context = await requireBundleAdmin();
  const organization = context.data.organization!;

  const roster = await db
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.organizationId, context.organizationId),
        isNull(contacts.archivedAt),
      ),
    )
    .orderBy(asc(contacts.lastName), asc(contacts.firstName));

  const admins = roster.filter((c) => c.isBundleAdmin);
  const primary = roster.find((c) => c.isPrimaryContact) ?? null;

  return (
    <>
      <PageIntro
        eyebrow="Bundle administration"
        title={organization.displayName}
        lede={
          <>
            Everyone covered by this membership. Add colleagues, hand over the
            administrator role, and keep the primary contact right — that is who
            renewal notices and invoices go to.
          </>
        }
      />

      <div className="flex flex-col gap-12">
        <Section title="Organisation">
          <Facts
            items={[
              { label: "Legal name", value: organization.legalName },
              { label: "Category", value: humanize(organization.category) },
              {
                label: "Licence types",
                value: organization.licenseTypes?.length
                  ? organization.licenseTypes.join(", ")
                  : "None recorded",
                hint: "Licence types drive automatic sector council enrolment.",
              },
              {
                label: "Member since",
                value: formatDate(organization.memberSince),
              },
              {
                label: "Primary contact",
                value: primary ? primary.displayName : "Not set",
                hint: primary?.email,
              },
              {
                label: "Contacts on the bundle",
                value: `${roster.length}`,
                hint: `${admins.length} ${admins.length === 1 ? "administrator" : "administrators"}`,
              },
            ]}
          />
          <p className="mt-5 text-[13px] text-zinc-500">
            Organisation details, licence numbers and the public directory
            listing are maintained by WACA staff — email{" "}
            <a className="portal-link" href="mailto:info@example.org">
              info@example.org
            </a>{" "}
            with any change.
          </p>
        </Section>

        <Section
          title="Contacts"
          description="Everyone here is covered by the membership: they can sign in, read the library, and register at member rates."
        >
          {roster.length ? (
            <Rows>
              {roster.map((person) => {
                const isSelf = person.id === context.contactId;
                return (
                  <Row key={person.id} className="py-5">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                      <h3 className="text-[16px] font-medium text-zinc-900">
                        {person.displayName}
                        {isSelf ? (
                          <span className="font-normal text-zinc-500"> — you</span>
                        ) : null}
                      </h3>
                      <p className="text-[13px] text-zinc-500">{person.email}</p>
                    </div>

                    <p className="mt-1.5 flex flex-wrap items-center gap-2">
                      {person.title ? (
                        <span className="text-[13px] text-zinc-500">
                          {person.title}
                        </span>
                      ) : null}
                      {person.isPrimaryContact ? (
                        <Pill tone="neutral">Primary contact</Pill>
                      ) : null}
                      {person.isBundleAdmin ? (
                        <Pill tone="neutral">Bundle administrator</Pill>
                      ) : null}
                    </p>

                    <div className="mt-4 flex flex-wrap items-start gap-x-8 gap-y-3">
                      {!person.isPrimaryContact ? (
                        <ActionButton
                          action={setPrimaryContactAction}
                          label="Make primary contact"
                          variant="quiet"
                          fields={{ contactId: person.id }}
                        />
                      ) : null}

                      <ActionButton
                        action={setBundleAdminAction}
                        label={
                          person.isBundleAdmin
                            ? "Remove administrator role"
                            : "Make bundle administrator"
                        }
                        variant="quiet"
                        fields={{
                          contactId: person.id,
                          value: person.isBundleAdmin ? "off" : "on",
                        }}
                      />

                      {!isSelf ? (
                        <ActionButton
                          action={removeBundleContactAction}
                          label="Remove from bundle"
                          variant="danger"
                          fields={{ contactId: person.id }}
                          confirm={`Remove ${person.displayName} from ${organization.displayName}? They will lose access to the portal. Their history is kept.`}
                        />
                      ) : null}
                    </div>
                  </Row>
                );
              })}
            </Rows>
          ) : (
            <EmptyState title="Nobody is on this bundle yet.">
              <p>Add your first colleague below.</p>
            </EmptyState>
          )}
        </Section>

        <Section
          title="Add a colleague"
          description="They are covered immediately — no extra fee, no invoice, no wait for staff."
        >
          <AddContactForm />
        </Section>
      </div>
    </>
  );
}
