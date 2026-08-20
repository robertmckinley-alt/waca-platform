import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { getCampaign } from "@/db/queries";
import { Badge, PageHeader, Tabs, type TabItem } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { CATEGORY_LABELS, STATUS_LABELS, STATUS_TONE, count } from "@/lib/email/campaign";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const detail = await getCampaign(id);
  return { title: detail?.campaign.name ?? "Campaign" };
}

/**
 * The campaign shell. Four stops, in the order the work actually happens:
 * build it, look at it, be stopped by the gate, then watch what it did.
 */
export default async function CampaignLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await getCampaign(id);
  if (!detail) notFound();
  const { campaign } = detail;

  const base = `/admin/email/campaigns/${id}`;
  const tabs: TabItem[] = [
    { href: base, label: "Builder", exact: true },
    { href: `${base}/preview`, label: "Preview" },
    {
      href: `${base}/review`,
      label: "Review & approve",
      badge: detail.readyToSend ? null : detail.blockers.length || null,
    },
    { href: `${base}/report`, label: "Report" },
  ];

  return (
    <>
      <PageHeader
        title={campaign.name}
        breadcrumb={[
          { label: "Email", href: "/admin/email" },
          { label: "Campaigns", href: "/admin/email/campaigns" },
        ]}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge tone={STATUS_TONE[campaign.status]}>
              {STATUS_LABELS[campaign.status]}
            </Badge>
            <span>{CATEGORY_LABELS[campaign.category]}</span>
            <span aria-hidden>·</span>
            <span>
              {detail.audience ? detail.audience.name : "no audience yet"}
            </span>
            <span aria-hidden>·</span>
            <span>{count(campaign.recipientCount)} recipients</span>
            {campaign.approvedAt ? (
              <>
                <span aria-hidden>·</span>
                <span>approved {formatDateTime(campaign.approvedAt)}</span>
              </>
            ) : null}
          </span>
        }
      />
      <Tabs items={tabs} label="Campaign sections" className="mb-4" />
      {children}
    </>
  );
}
