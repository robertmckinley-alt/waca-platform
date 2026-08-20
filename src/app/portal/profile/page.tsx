import Link from "next/link";

import { EmptyState, Facts, PageIntro, Pill, Section } from "@/components/portal/ui";
import { formatDate, humanize } from "@/lib/format";
import { getMemberContactFields } from "@/lib/portal/contact-fields";
import { requirePortal } from "@/lib/portal/session";

import { ProfileForm } from "./profile-form";

export const metadata = { title: "Your profile" };
export const dynamic = "force-dynamic";

/**
 * YOUR CONTACT RECORD.
 *
 * The row edited here is pinned to the session's contact id. There is no
 * contact id anywhere in the form, so there is nothing to tamper with.
 */
export default async function ProfilePage() {
  const context = await requirePortal();
  const { contact, organization, councils } = context.data;
  const fields = await getMemberContactFields();
  const readOnly = fields.filter((field) => !field.editable);

  return (
    <>
      <PageIntro
        eyebrow="Your details"
        title={contact.displayName}
        lede={
          <>
            What WACA has on file for you. Everything here is yours to change —
            except your email address, which is also how you sign in.
          </>
        }
      />

      <div className="flex flex-col gap-12">
        <Section title="Edit your details">
          <ProfileForm
            fields={fields}
            defaults={{
              firstName: contact.firstName,
              lastName: contact.lastName,
              title: contact.title ?? "",
              phone: contact.phone ?? "",
              mobile: contact.mobile ?? "",
              emailOptIn: contact.emailOptIn,
              directoryOptIn: contact.directoryOptIn,
              fieldValues: contact.contactFieldValues ?? {},
            }}
          />
        </Section>

        <Section title="Held by WACA, not editable here">
          <Facts
            items={[
              {
                label: "Email address",
                value: contact.email,
                hint: "This is your sign-in identity. Email info@example.org to change it and staff will move the login with it.",
              },
              {
                label: "Organisation",
                value: organization ? (
                  organization.displayName
                ) : (
                  <span className="text-zinc-500">Not attached to a bundle</span>
                ),
                hint: organization
                  ? `${humanize(organization.category)}${organization.memberSince ? ` · member since ${formatDate(organization.memberSince)}` : ""}`
                  : undefined,
              },
              {
                label: "Your role in the bundle",
                value: (
                  <span className="flex flex-wrap gap-2">
                    {contact.isBundleAdmin ? (
                      <Pill tone="neutral">Bundle administrator</Pill>
                    ) : null}
                    {contact.isPrimaryContact ? (
                      <Pill tone="neutral">Primary contact</Pill>
                    ) : null}
                    {!contact.isBundleAdmin && !contact.isPrimaryContact ? (
                      <Pill tone="quiet">Member contact</Pill>
                    ) : null}
                  </span>
                ),
                hint: contact.isBundleAdmin ? (
                  <>
                    You can{" "}
                    <Link href="/portal/organization" className="portal-link">
                      manage your organisation&rsquo;s contacts
                    </Link>
                    .
                  </>
                ) : (
                  "Bundle administrators add and remove contacts on the membership."
                ),
              },
              {
                label: "Sector councils",
                value: councils.length
                  ? councils.map((c) => c.name).join(", ")
                  : "None",
                hint: "Enrolment follows your organisation's licence types.",
              },
              ...readOnly.map((field) => ({
                label: field.label,
                value:
                  (contact.contactFieldValues?.[field.key] as string | undefined) ??
                  "—",
                hint: "Maintained by WACA staff.",
              })),
            ]}
          />
        </Section>

        <Section title="Leaving WACA">
          <EmptyState title="Need your record removed?">
            <p>
              Email{" "}
              <a className="portal-link" href="mailto:info@example.org">
                info@example.org
              </a>{" "}
              and staff will archive your contact record. Membership records and
              invoices are kept for WACA&rsquo;s own accounting and audit
              obligations even after a contact is archived.
            </p>
          </EmptyState>
        </Section>
      </div>
    </>
  );
}
