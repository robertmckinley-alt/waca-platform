/**
 * ============================================================================
 *  WACA query helpers -- the shared data contract.
 *
 *  Module agents: import from "@/db/queries". Do NOT invent your own version
 *  of these. If you need a variant, add a parameter here so every module
 *  benefits and the access rules stay in one place.
 *
 *  Signatures (see the individual files for the row shapes):
 *
 *    listMembers(params?: ListMembersParams): Promise<Paginated<MemberListRow>>
 *    getMemberDetail(organizationId: string, opts?): Promise<MemberDetail | null>
 *    listExpiringMemberships(params?): Promise<ExpiringMembershipRow[]>
 *    listEvents(params: ListEventsParams): Promise<Paginated<EventListRow>>
 *    getEventDetail(idOrSlug: string, viewer: Viewer, opts?): Promise<EventDetail | null>
 *    listInvoices(params?: ListInvoicesParams): Promise<Paginated<InvoiceListRow>>
 *    getInvoiceDetail(invoiceId: string, opts?): Promise<InvoiceDetail | null>
 *    getContactPortalData(contactId: string, opts?): Promise<ContactPortalData | null>
 *    listDocumentsFor(viewer: Viewer, params?): Promise<Paginated<DocumentListRow>>
 *    getDocumentFor(idOrSlug: string, viewer: Viewer, opts?): Promise<Document | null>
 *    listCouncils(params?): Promise<CouncilListRow[]>
 *    getDashboardSummary(opts?): Promise<DashboardSummary>
 *
 *  CONTENT (src/db/queries/content.ts):
 *    listContent(params?: ListContentParams): Promise<Paginated<ContentListRow>>
 *    getContentItem(idOrSlug: string, opts?): Promise<ContentItemDetail | null>
 *    listRevisions(itemId: string, params?): Promise<Paginated<ContentRevisionRow>>
 *    saveDraft(input: SaveDraftInput): Promise<SaveDraftResult>
 *    restoreRevision(input: RestoreRevisionInput): Promise<SaveDraftResult>
 *    publishItems(input: PublishItemsInput): Promise<PublishRunResult>
 *    listPublishedForApi(params?): Promise<PublishedContentEnvelope>
 *
 *  EMAIL (src/db/queries/email.ts):
 *    listAudiences(params?): Promise<Paginated<AudienceListRow>>
 *    resolveAudience(rules: AudienceRule, opts?): Promise<string[]>
 *    previewAudienceCount(rules: AudienceRule, opts?): Promise<AudiencePreview>
 *    listCampaigns(params?): Promise<Paginated<CampaignListRow>>
 *    getCampaign(campaignId: string, opts?): Promise<CampaignDetail | null>
 *    buildRecipients(input: BuildRecipientsInput): Promise<BuildRecipientsResult>
 *    listSuppressions(params?): Promise<Paginated<SuppressionRow>>
 *    suppress(input: SuppressInput): Promise<Suppression>
 *    isSuppressed(email: string, opts?): Promise<boolean>

 *  EMAIL DELIVERY (src/db/queries/email-delivery.ts) — the send pipeline's
 *  half. Nothing in it can START a send; see the file header.
 *    claimPendingRecipients(input): Promise<ClaimedRecipient[]>
 *    markRecipientSent | markRecipientFailed | markRecipientSuppressed
 *    dedupeRecipientsByEmail(campaignId, opts?): Promise<number>
 *    campaignSendProgress(campaignId, opts?): Promise<SendProgress>
 *    recomputeCampaignStats(campaignId, opts?): Promise<void>
 *    recordEmailEvent(input): Promise<RecordEmailEventResult>
 *    applyRecipientOutcome(input): Promise<void>
 *    listDispatchableCampaigns(opts?): Promise<DispatchableCampaign[]>
 *    transactionalBlock(email, opts?): Promise<SuppressionBlock>
 *    undoUnsubscribeToken(token, opts?): Promise<UndoUnsubscribeResult>
 *
 *  Three rules that are not negotiable:
 *    1. Anything that returns events or documents takes a `Viewer` and
 *       filters on it. Non-public events must never reach the public API.
 *    2. Money is integer cents. Format at the edge, never in the query.
 *    3. Nothing but buildRecipients() inserts into campaign_recipients, and
 *       nothing but beginCampaignSend() moves a campaign to 'sending'. Both
 *       consult the global suppression list / the human confirmation token,
 *       and the database will refuse you if you go around them.
 * ============================================================================
 */

export * from "./types";
export * from "./viewer";
export * from "./members";
export * from "./events";
export * from "./finance";
export * from "./documents";
export * from "./portal";
export * from "./councils";
export * from "./dashboard";
export * from "./admin";
export * from "./content";
export * from "./email";
export * from "./email-delivery";
