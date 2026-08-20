import type { Metadata } from "next";

import { listAudiences, listTemplates, previewAudienceDeductions } from "@/db/queries";
import {
  ActionForm,
  Field,
  Input,
  PageHeader,
  Panel,
  Select,
} from "@/components/ui";
import {
  CATEGORY_HINTS,
  CATEGORY_LABELS,
  EMAIL_CATEGORIES,
  count,
} from "@/lib/email/campaign";
import { ORG_NAME } from "@/lib/constants";
import { createCampaignAction } from "../../actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "New campaign" };

const DEFAULT_FROM =
  process.env.EMAIL_FROM?.match(/<([^>]+)>/)?.[1] ??
  process.env.EMAIL_FROM ??
  "news@example.org";

export default async function NewCampaignPage() {
  const [audienceList, templateList] = await Promise.all([
    listAudiences({ pageSize: 200 }),
    listTemplates({ pageSize: 200 }),
  ]);

  // Live counts next to each audience name. The choice of who a campaign goes
  // to is the most consequential field on this form, and picking it blind
  // from a dropdown of names is how the wrong three thousand people get mail.
  const withCounts = await Promise.all(
    audienceList.rows.slice(0, 60).map(async (a) => ({
      ...a,
      deductions: await previewAudienceDeductions(a.id),
    })),
  );

  return (
    <>
      <PageHeader
        title="New campaign"
        description="From scratch, or from a template. A template is copied, never linked — editing the template later cannot rewrite a campaign somebody already approved."
        breadcrumb={[
          { label: "Email", href: "/admin/email" },
          { label: "Campaigns", href: "/admin/email/campaigns" },
        ]}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-2" title="The campaign">
          <ActionForm action={createCampaignAction} submitLabel="Create and open the builder">
            <Field
              label="Name"
              name="name"
              required
              hint="Internal only — never shown to a recipient. “March member newsletter”, “HB 1234 committee alert”."
            >
              <Input name="name" maxLength={200} autoComplete="off" />
            </Field>

            <Field
              label="Subject line"
              name="subject"
              hint="You can leave this until the builder. It is shown in the inbox and can carry merge fields."
            >
              <Input name="subject" maxLength={300} autoComplete="off" />
            </Field>

            <Field
              label="Category"
              name="category"
              required
              hint="Which category-scoped unsubscribes apply. This CANNOT be changed once the campaign leaves draft — otherwise a send could relabel itself around somebody's opt-out."
            >
              <Select name="category" defaultValue="newsletter">
                {EMAIL_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]} — {CATEGORY_HINTS[c]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Audience"
              name="audienceId"
              hint="Can be chosen later, but nothing can be approved without one."
            >
              <Select name="audienceId" defaultValue="">
                <option value="">Decide later</option>
                {withCounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} — {count(a.deductions.mailable)} mailable
                    {a.isDynamic ? "" : " (frozen snapshot)"}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Start from a template"
              name="templateId"
              hint="Copies the template's subject, preheader and blocks into a new campaign."
            >
              <Select name="templateId" defaultValue="">
                <option value="">Start from scratch</option>
                {templateList.rows.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.blocks.length} block
                    {t.blocks.length === 1 ? "" : "s"})
                  </option>
                ))}
              </Select>
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="From name" name="fromName" required>
                <Input name="fromName" defaultValue={ORG_NAME} maxLength={120} />
              </Field>
              <Field label="From address" name="fromEmail" required>
                <Input
                  name="fromEmail"
                  type="email"
                  defaultValue={DEFAULT_FROM}
                  maxLength={320}
                />
              </Field>
            </div>

            <Field
              label="Reply-to"
              name="replyTo"
              hint="Where replies go. Leave blank to use the from address — but somebody has to be reading it."
            >
              <Input name="replyTo" type="email" maxLength={320} />
            </Field>
          </ActionForm>
        </Panel>

        <Panel title="What happens next">
          <ol className="list-decimal space-y-2 pl-4 text-[13px] text-zinc-700">
            <li>
              <strong>Build the body</strong> from blocks. HTML and plain text
              are rendered from the same blocks on every save.
            </li>
            <li>
              <strong>Preview</strong> it on desktop, on a phone, and as plain
              text — and send yourself a test.
            </li>
            <li>
              <strong>Review.</strong> Nine checks have to be green, including a
              live check that every link resolves.
            </li>
            <li>
              <strong>Type the recipient count</strong> back. Not a checkbox.
            </li>
            <li>
              <strong>Approve.</strong> That records who approved it and mints a
              single-use confirmation that expires in 30 minutes.
            </li>
          </ol>
          <p className="mt-3 border-t border-zinc-200 pt-3 text-[12px] text-zinc-500">
            The database enforces steps 4 and 5 independently of this interface:
            a campaign row physically cannot reach <code>sending</code> without
            a named approver and a redeemed token.
          </p>
        </Panel>
      </div>
    </>
  );
}
