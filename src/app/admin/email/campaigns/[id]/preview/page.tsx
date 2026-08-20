import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";

import { auth } from "@/auth";
import { getCampaign, sampleAudienceById, type AudienceSampleRow } from "@/db/queries";
import {
  ActionForm,
  Badge,
  Field,
  Input,
  Panel,
  Select,
  buttonClass,} from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import {
  applyMerge,
  defaultSystemFields,
  type MergeContext,
} from "@/lib/email/campaign";
import type { RawSearchParams } from "@/lib/search-params";
import { readString } from "@/lib/search-params";
import { sendTestEmailAction } from "../../../actions";
import { DeliveryModeBanner } from "@/components/email/delivery-banner";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Preview" };

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

function toMergeSubject(r: AudienceSampleRow) {
  return {
    contactId: r.contactId,
    firstName: r.firstName,
    lastName: r.lastName,
    displayName: r.displayName,
    email: r.email,
    title: r.title,
    organizationName: r.organizationName,
    organizationCategory: r.organizationCategory,
    membershipLevel: r.membershipLevel,
    membershipStatus: r.membershipStatus,
    renewalDate: r.renewalDate,
    memberSince: r.memberSince,
    councils: r.councils,
  };
}

export default async function CampaignPreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const [{ id }, sp, session] = await Promise.all([
    params,
    searchParams,
    auth(),
  ]);
  const detail = await getCampaign(id);
  if (!detail) notFound();
  const { campaign } = detail;

  const sample = campaign.audienceId
    ? await sampleAudienceById(campaign.audienceId, {
        limit: 25,
        includeSuppressed: false,
      })
    : [];

  const asId = readString(sp, "as");
  const chosen = sample.find((s) => s.contactId === asId) ?? null;

  /**
   * THE PREVIEW IS MERGED. Previewing the raw body with {{first_name}} sitting
   * in it tells you nothing about what a recipient sees — and, more to the
   * point, tells you nothing about what the 3,150 people with no membership
   * level see, which is the case that actually goes wrong.
   *
   * With nobody chosen, `subject: null` forces EVERY field to its fallback.
   * That is the worst case, and it is the default view on purpose.
   */
  const ctx: MergeContext = {
    subject: chosen ? toMergeSubject(chosen) : null,
    system: defaultSystemFields({
      unsubscribeUrl: `${APP_URL}/unsubscribe?preview=1`,
      viewInBrowserUrl: `${APP_URL}/admin/email/campaigns/${id}/preview`,
    }),
  };

  const subject = applyMerge(campaign.subject, ctx);
  const preheader = applyMerge(campaign.preheader ?? "", ctx);
  const html = applyMerge(campaign.htmlBody, ctx);
  const text = applyMerge(campaign.textBody, ctx);

  const staffEmail = session?.user?.email ?? "";
  const base = `/admin/email/campaigns/${id}`;

  return (
    <div className="flex flex-col gap-4">
      {/* ------------------------------------------------- who we merged as */}
      <Panel
        title="Rendered as"
        description="Everything below is merged. The default is nobody — every merge field falls back — because that is what most of a 3,246-contact list actually receives."
      >
        <form method="get" className="flex flex-wrap items-end gap-2">
          <Field
            label="Preview as"
            htmlFor="as"
            className="min-w-72 flex-1"
            hint={
              campaign.audienceId
                ? "A real contact from this campaign's audience, drawn by the same predicate that will build the send."
                : "No audience selected, so there is nobody to draw a sample from."
            }
          >
            <Select id="as" name="as" defaultValue={asId ?? ""}>
              <option value="">
                Nobody — show every fallback (the worst case)
              </option>
              {sample.map((s) => (
                <option key={s.contactId} value={s.contactId}>
                  {s.displayName ?? s.email}
                  {s.membershipLevel ? ` — ${s.membershipLevel}` : " — non-member"}
                </option>
              ))}
            </Select>
          </Field>
          <button type="submit" className={buttonClass("secondary")}>
            Re-render
          </button>
        </form>

        <dl className="mt-3 grid gap-2 border-t border-zinc-200 pt-3 text-[13px] sm:grid-cols-2">
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              Subject as it will appear
            </dt>
            <dd className="mt-0.5 font-medium text-zinc-900">
              {subject || <em className="text-red-600">no subject</em>}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              Preheader
            </dt>
            <dd className="mt-0.5 text-zinc-700">
              {preheader || <em className="text-zinc-500">none</em>}
            </dd>
          </div>
        </dl>
      </Panel>

      {/* --------------------------------------------- the three renderings */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <Panel
          title="Desktop"
          description="600px, the width every mail client agrees on."
          bodyClassName="p-0"
        >
          <iframe
            title="Desktop rendering of this campaign"
            srcDoc={html}
            sandbox=""
            className="h-[42rem] w-full rounded-b-md border-0 bg-zinc-100"
          />
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel
            title="Mobile"
            description="375px — an iPhone in portrait. Roughly two thirds of WACA's opens."
            bodyClassName="p-3"
          >
            <div className="mx-auto w-[375px] max-w-full overflow-hidden rounded border border-zinc-300">
              <iframe
                title="Mobile rendering of this campaign at 375 pixels wide"
                srcDoc={html}
                sandbox=""
                className="h-[36rem] w-[375px] border-0 bg-zinc-100"
              />
            </div>
          </Panel>
        </div>
      </div>

      <Panel
        title="Plain text"
        description="Rendered from the same blocks as the HTML — not stripped out of it. This is what a spam filter scores, what a text-mode client shows, and what an Outlook rule can reduce the message to."
      >
        {/* A scrollable region has to be reachable from a keyboard (WCAG 2.1.1),
            and a focusable region needs an accessible name. */}
        <pre
          tabIndex={0}
          role="region"
          aria-label="Plain-text rendering of this campaign"
          className="max-h-[32rem] overflow-auto rounded border border-zinc-200 bg-zinc-50 p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
        >
          {text || "(nothing rendered yet — save the body once)"}
        </pre>
      </Panel>

      {/* --------------------------------------------------------- the test */}
      <Panel
        title="Send a test to yourself"
        description="Goes through the same provider and the same from address as a real send. It never touches the recipient list and never counts towards a campaign's statistics."
      >
        {campaign.testSentAt ? (
          <p className="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-zinc-600">
            <Badge tone="positive">Tested</Badge>
            Last test of this version went to{" "}
            <strong>{campaign.testSentTo}</strong> on{" "}
            {formatDateTime(campaign.testSentAt)}.
          </p>
        ) : (
          <p className="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-zinc-600">
            <Badge tone="warning">Not tested</Badge>
            No test has been sent for this version. The{" "}
            <Link href={`${base}/review`} className="underline">
              review gate
            </Link>{" "}
            will not let this campaign be approved until one has.
          </p>
        )}

        <ActionForm action={sendTestEmailAction} submitLabel="Send the test">
          <input type="hidden" name="campaignId" value={id} />
          <input type="hidden" name="asContactId" value={chosen?.contactId ?? ""} />
          <Field
            label="Send it to"
            name="to"
            required
            hint="Your own address. Read it on a phone — that is where most of this list opens mail."
          >
            <Input name="to" type="email" defaultValue={staffEmail} maxLength={320} />
          </Field>
          <p className="text-[12px] text-zinc-500">
            Merged as:{" "}
            <strong>
              {chosen ? (chosen.displayName ?? chosen.email) : "nobody — fallbacks only"}
            </strong>
            . The unsubscribe link in a test is deliberately inert, so
            forwarding one cannot unsubscribe anybody.
          </p>
          <DeliveryModeBanner
            className=""
            context="A test send will be rendered in full and printed to the server console instead of transmitted, and the review gate will still count this campaign as untested."
          />
        </ActionForm>
      </Panel>
    </div>
  );
}
