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
 *  Two rules that are not negotiable:
 *    1. Anything that returns events or documents takes a `Viewer` and
 *       filters on it. Non-public events must never reach the public API.
 *    2. Money is integer cents. Format at the edge, never in the query.
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
