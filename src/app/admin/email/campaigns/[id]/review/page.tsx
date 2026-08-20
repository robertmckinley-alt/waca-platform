import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";

import { getCampaign, previewAudienceDeductions } from "@/db/queries";
import {
  ActionForm,
  Badge,
  Field,
  Input,
  LinkButton,
  Panel,
  StatTile,
} from "@/components/ui";
import { TypedCountConfirm } from "@/components/email/typed-confirm";
import { formatDateTime } from "@/lib/format";
import {
  checkLinks,
  count,
  runReview,
  type ChecklistItem,
} from "@/lib/email/campaign";
import {
  approveForSendAction,
  buildRecipientsAction,
  startSendAction,
  transitionCampaignAction,
} from "../../../actions";
import { DeliveryModeBanner } from "@/components/email/delivery-banner";
import { deliveryStatus } from "@/lib/email";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Review & approve" };

const EMPTY = {
  matched: 0,
  suppressed: 0,
  mailable: 0,
  optedOut: 0,
  bounced: 0,
  unsubscribed: 0,
  complained: 0,
  manual: 0,
};

function Check({ item }: { item: ChecklistItem }) {
  const tone =
    item.state === "pass" ? "positive" : item.state === "warn" ? "warning" : "danger";
  return (
    <li className="flex items-start gap-3 border-b border-zinc-200 px-3 py-2.5 last:border-b-0">
      <span className="mt-0.5 shrink-0">
        <Badge tone={tone}>
          {item.state === "pass" ? "Pass" : item.state === "warn" ? "Check" : "Fail"}
        </Badge>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-zinc-900">
          {item.label}
          {!item.blocking ? (
            <span className="ml-1.5 text-[11px] font-normal text-zinc-500">
              (does not block)
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block break-words text-[12px] text-zinc-600">
          {item.detail}
        </span>
      </span>
      {item.fix ? (
        <LinkButton href={item.fix.href}>{item.fix.label}</LinkButton>
      ) : null}
    </li>
  );
}

export default async function CampaignReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await getCampaign(id);
  if (!detail) notFound();
  const { campaign } = detail;

  const deductions = campaign.audienceId
    ? await previewAudienceDeductions(campaign.audienceId)
    : EMPTY;

  /**
   * THE LINK CHECK IS REAL, and it runs on every render of this page. It is
   * bounded — 8s per link, six at a time, 60 links maximum — so a campaign
   * pointing at a hung host slows this screen down instead of hanging it.
   *
   * The same call is made again inside approveForSendAction against fresh
   * rows, so a link that breaks between this render and the approval still
   * stops the send.
   */
  const linkChecks = await checkLinks(campaign.htmlBody);

  const review = runReview({
    campaign,
    audience: detail.audience,
    deductions,
    builtRecipientCount: campaign.recipientCount || null,
    linkChecks,
    dryRun: !deliveryStatus().transmitting,
  });

  const blocking = review.items.filter((i) => i.blocking);
  const passed = blocking.filter((i) => i.state === "pass").length;

  const approvalLive =
    Boolean(campaign.approvedAt && campaign.sendConfirmationToken) &&
    !campaign.sendConfirmedAt &&
    (!campaign.sendConfirmationExpiresAt ||
      campaign.sendConfirmationExpiresAt > new Date());

  const drifted =
    campaign.approvedRecipientCount !== null &&
    campaign.approvedRecipientCount > 0 &&
    Math.abs(campaign.recipientCount - campaign.approvedRecipientCount) /
      campaign.approvedRecipientCount >
      0.05;

  const terminal = ["sent", "cancelled", "sending"].includes(campaign.status);

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="flex min-w-0 flex-col gap-4">
        <Panel
          title={`Pre-send checklist — ${passed} of ${blocking.length} green`}
          description="Every blocking check is a fact about this campaign row and its rendered bytes, re-checked here and again inside the approve action. A stale tab cannot approve something this gate would refuse."
          bodyClassName="p-0"
        >
          <ul className="list-none">
            {review.items.map((item) => (
              <Check key={item.key} item={item} />
            ))}
          </ul>
        </Panel>

        {linkChecks.length > 0 ? (
          <Panel
            title="Links"
            description="HEAD-checked just now. A server that answers but refuses an automated request is flagged rather than failed — bot protection is not a broken link, and failing on it would teach people to click past this screen."
            bodyClassName="p-0"
          >
            <ul className="list-none divide-y divide-zinc-200">
              {linkChecks.map((l) => (
                <li
                  key={l.url}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-[12px]"
                >
                  <Badge
                    tone={
                      l.state === "pass"
                        ? "positive"
                        : l.state === "warn"
                          ? "warning"
                          : "danger"
                    }
                  >
                    {l.status ?? "—"}
                  </Badge>
                  <code className="min-w-0 flex-1 break-all text-zinc-700">
                    {l.url}
                  </code>
                  <span className="text-zinc-500">{l.note}</span>
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}

        <Panel
          title="Advice"
          description="Subject length, preheader and spam triggers. None of this blocks a send — WACA's newsletter runs at roughly a 60% open rate and the people writing it know the audience better than a word list does."
        >
          <ul className="flex flex-col gap-1.5">
            {review.advisories.map((a) => (
              <li key={a.key} className="flex items-start gap-2 text-[12px]">
                <Badge tone={a.severity === "warning" ? "warning" : "muted"}>
                  {a.severity === "warning" ? "Worth a look" : "FYI"}
                </Badge>
                <span className="text-zinc-600">{a.message}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      {/* ---------------------------------------------------- the gate */}
      <div className="flex flex-col gap-4">
        <Panel
          title="Who receives this"
          className={review.recipients.finalCount > 0 ? "border-zinc-900" : undefined}
        >
          <p className="text-[14px] leading-relaxed text-zinc-900">
            {review.recipients.sentence}
          </p>
          <dl className="mt-3 flex flex-col gap-1 border-t border-zinc-200 pt-3 text-[12px]">
            {review.recipients.steps.map((s) => (
              <div key={s.label} className="flex justify-between gap-3">
                <dt className="text-zinc-500">{s.label}</dt>
                <dd className="tabular font-medium text-zinc-900">
                  {count(s.value)}
                  {s.delta !== null && s.delta !== 0 ? (
                    <span className="ml-1 font-normal text-zinc-500">
                      ({s.delta > 0 ? "+" : ""}
                      {count(s.delta)})
                    </span>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>

          {campaign.recipientCount !== review.recipients.afterBounces ? (
            <div className="mt-3 border-t border-zinc-200 pt-3">
              <p className="mb-2 text-[12px] text-amber-800">
                The built list ({count(campaign.recipientCount)}) does not match
                what the audience resolves to right now (
                {count(review.recipients.afterBounces)}). Rebuild it so the
                number you approve is the number that goes out.
              </p>
              <ActionForm
                action={buildRecipientsAction}
                submitLabel="Rebuild the recipient list"
                submitVariant="secondary"
              >
                <input type="hidden" name="campaignId" value={id} />
              </ActionForm>
            </div>
          ) : null}
        </Panel>

        {terminal ? (
          <Panel title="Dispatch">
            <p className="text-[13px] text-zinc-700">
              This campaign is <strong>{campaign.status}</strong>. Follow it on
              the{" "}
              <Link
                href={`/admin/email/campaigns/${id}/report`}
                className="underline"
              >
                report
              </Link>
              .
            </p>
          </Panel>
        ) : approvalLive && !drifted ? (
          <Panel title="Approved — ready to dispatch" className="border-zinc-900">
            <dl className="mb-3 flex flex-col gap-1 text-[12px]">
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Approved</dt>
                <dd className="text-zinc-900">
                  {formatDateTime(campaign.approvedAt)}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Confirmation expires</dt>
                <dd className="text-zinc-900">
                  {campaign.sendConfirmationExpiresAt
                    ? formatDateTime(campaign.sendConfirmationExpiresAt)
                    : "never"}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Approved for</dt>
                <dd className="tabular text-zinc-900">
                  {count(campaign.approvedRecipientCount ?? 0)} recipients
                </dd>
              </div>
            </dl>

            <ActionForm
              action={startSendAction}
              submitLabel={`Send to ${count(campaign.recipientCount)} people now`}
              confirm={`This dispatches to ${campaign.recipientCount.toLocaleString(
                "en-US",
              )} real people and cannot be undone. Continue?`}
            >
              <input type="hidden" name="campaignId" value={id} />
            </ActionForm>

            <p className="mt-2 text-[11px] text-zinc-500">
              This redeems the confirmation token in the same statement that
              moves the campaign to <code>sending</code>. The token is
              single-use: re-sending means approving again.
            </p>

            {/* The one banner, with the sentence this screen needs. There
                were three of these written out by hand in three files; that
                is three places for the wording to drift and one — the report —
                where it was simply forgotten. */}
            <DeliveryModeBanner
              className="mt-2"
              context="Pressing send here will rehearse the dispatch in full and transmit nothing."
            />

            <div className="mt-3 border-t border-zinc-200 pt-3">
              <ActionForm
                action={transitionCampaignAction}
                submitLabel="Cancel this campaign"
                submitVariant="danger"
                confirm="Cancelling is terminal — a cancelled campaign cannot be revived. Continue?"
              >
                <input type="hidden" name="campaignId" value={id} />
                <input type="hidden" name="to" value="cancelled" />
              </ActionForm>
            </div>
          </Panel>
        ) : (
          <Panel
            title="Approve"
            description="Records who approved this send and mints a single-use confirmation the database will demand before anything is dispatched."
          >
            {drifted ? (
              <p className="mb-3 rounded border border-amber-300 bg-amber-50 px-2.5 py-2 text-[12px] text-amber-900">
                The recipient list has moved from{" "}
                {count(campaign.approvedRecipientCount ?? 0)} to{" "}
                {count(campaign.recipientCount)} since it was approved. That is
                more than 5% and the approval no longer stands — approve it
                again so a human sees the new number.
              </p>
            ) : null}
            {campaign.approvedAt && campaign.sendConfirmationExpiresAt &&
            campaign.sendConfirmationExpiresAt <= new Date() ? (
              <p className="mb-3 rounded border border-amber-300 bg-amber-50 px-2.5 py-2 text-[12px] text-amber-900">
                The previous confirmation expired at{" "}
                {formatDateTime(campaign.sendConfirmationExpiresAt)}. Approve
                again.
              </p>
            ) : null}

            <TypedCountConfirm
              action={approveForSendAction}
              campaignId={id}
              expected={review.recipients.finalCount}
              blocked={!review.passed}
              blockedReason={
                review.passed
                  ? undefined
                  : `${review.blockingFailures.length} check${
                      review.blockingFailures.length === 1 ? "" : "s"
                    } still failing: ${review.blockingFailures
                      .map((f) => f.label)
                      .join("; ")}.`
              }
            />
          </Panel>
        )}

        <Panel title="Status">
          <div className="mb-3 grid gap-2">
            <StatTile
              label="Blocking checks"
              value={`${passed} / ${blocking.length}`}
              sub={review.passed ? "All green" : "Not ready"}
              emphasis={review.passed}
            />
          </div>
          {campaign.status === "draft" || campaign.status === "ready" ? (
            <ActionForm
              action={transitionCampaignAction}
              submitLabel={
                campaign.status === "draft"
                  ? "Mark ready to send"
                  : "Put back into draft"
              }
              submitVariant="secondary"
            >
              <input type="hidden" name="campaignId" value={id} />
              <input
                type="hidden"
                name="to"
                value={campaign.status === "draft" ? "ready" : "draft"}
              />
            </ActionForm>
          ) : null}

          {campaign.status === "ready" ? (
            <div className="mt-3 border-t border-zinc-200 pt-3">
              <ActionForm
                action={transitionCampaignAction}
                submitLabel="Schedule instead"
                submitVariant="secondary"
              >
                <input type="hidden" name="campaignId" value={id} />
                <input type="hidden" name="to" value="scheduled" />
                <Field
                  label="Send at"
                  name="scheduledAt"
                  hint="Scheduling is not approval. A scheduled campaign still needs a live confirmation token at the moment it dispatches."
                >
                  <Input name="scheduledAt" type="datetime-local" />
                </Field>
              </ActionForm>
            </div>
          ) : null}
        </Panel>
      </div>
    </div>
  );
}
