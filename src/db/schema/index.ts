/**
 * WACA Platform schema — barrel export.
 *
 * Import tables from "@/db/schema" (never from the individual files) so the
 * Drizzle relational query builder always sees the full schema object.
 */

export * from "./enums";
export * from "./auth";
export * from "./contacts";
export * from "./membership";
export * from "./councils";
export * from "./events";
export * from "./finance";
export * from "./documents";
export * from "./audit";

import { relations } from "drizzle-orm";
import { accounts, sessions, users } from "./auth";
import { contactFields, contacts, organizations } from "./contacts";
import {
  councilMembers,
  councilPriorities,
  councils,
} from "./councils";
import { documentDownloads, documents } from "./documents";
import {
  eventSessions,
  eventSponsorships,
  events,
  registrations,
  sponsorTiers,
  ticketTypes,
} from "./events";
import {
  invoiceLines,
  invoices,
  paymentAllocations,
  payments,
  refunds,
} from "./finance";
import {
  membershipApplications,
  membershipLevels,
  memberships,
  renewalReminderRules,
  renewalReminders,
} from "./membership";

/* --------------------------------------------------------------- auth */

export const usersRelations = relations(users, ({ one, many }) => ({
  contact: one(contacts, {
    fields: [users.contactId],
    references: [contacts.id],
    relationName: "userContact",
  }),
  accounts: many(accounts),
  sessions: many(sessions),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

/* ------------------------------------------------------ organisations */

export const organizationsRelations = relations(
  organizations,
  ({ many }) => ({
    contacts: many(contacts),
    memberships: many(memberships),
    applications: many(membershipApplications),
    invoices: many(invoices),
    payments: many(payments),
    refunds: many(refunds),
    registrations: many(registrations),
    sponsorships: many(eventSponsorships),
    councilMemberships: many(councilMembers),
  }),
);

export const contactsRelations = relations(contacts, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [contacts.organizationId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [contacts.userId],
    references: [users.id],
    relationName: "contactUser",
  }),
  registrations: many(registrations),
  councilMemberships: many(councilMembers),
  invoices: many(invoices),
  documentDownloads: many(documentDownloads),
}));

/* ---------------------------------------------------------- membership */

export const membershipLevelsRelations = relations(
  membershipLevels,
  ({ many }) => ({
    memberships: many(memberships),
    reminderRules: many(renewalReminderRules),
  }),
);

export const membershipsRelations = relations(
  memberships,
  ({ one, many }) => ({
    organization: one(organizations, {
      fields: [memberships.organizationId],
      references: [organizations.id],
    }),
    level: one(membershipLevels, {
      fields: [memberships.levelId],
      references: [membershipLevels.id],
    }),
    invoices: many(invoices),
    reminders: many(renewalReminders),
    applications: many(membershipApplications),
  }),
);

export const membershipApplicationsRelations = relations(
  membershipApplications,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [membershipApplications.organizationId],
      references: [organizations.id],
    }),
    membership: one(memberships, {
      fields: [membershipApplications.membershipId],
      references: [memberships.id],
    }),
    requestedLevel: one(membershipLevels, {
      fields: [membershipApplications.requestedLevelId],
      references: [membershipLevels.id],
      relationName: "requestedLevel",
    }),
    currentLevel: one(membershipLevels, {
      fields: [membershipApplications.currentLevelId],
      references: [membershipLevels.id],
      relationName: "currentLevel",
    }),
    submittedByContact: one(contacts, {
      fields: [membershipApplications.submittedByContactId],
      references: [contacts.id],
    }),
  }),
);

export const renewalReminderRulesRelations = relations(
  renewalReminderRules,
  ({ one, many }) => ({
    level: one(membershipLevels, {
      fields: [renewalReminderRules.levelId],
      references: [membershipLevels.id],
    }),
    reminders: many(renewalReminders),
  }),
);

export const renewalRemindersRelations = relations(
  renewalReminders,
  ({ one }) => ({
    membership: one(memberships, {
      fields: [renewalReminders.membershipId],
      references: [memberships.id],
    }),
    rule: one(renewalReminderRules, {
      fields: [renewalReminders.ruleId],
      references: [renewalReminderRules.id],
    }),
    contact: one(contacts, {
      fields: [renewalReminders.contactId],
      references: [contacts.id],
    }),
  }),
);

/* ------------------------------------------------------------ councils */

export const councilsRelations = relations(councils, ({ one, many }) => ({
  members: many(councilMembers),
  priorities: many(councilPriorities),
  documents: many(documents),
  events: many(events),
  staffLiaison: one(contacts, {
    fields: [councils.staffLiaisonContactId],
    references: [contacts.id],
  }),
}));

export const councilMembersRelations = relations(councilMembers, ({ one }) => ({
  council: one(councils, {
    fields: [councilMembers.councilId],
    references: [councils.id],
  }),
  contact: one(contacts, {
    fields: [councilMembers.contactId],
    references: [contacts.id],
  }),
  organization: one(organizations, {
    fields: [councilMembers.organizationId],
    references: [organizations.id],
  }),
}));

export const councilPrioritiesRelations = relations(
  councilPriorities,
  ({ one }) => ({
    council: one(councils, {
      fields: [councilPriorities.councilId],
      references: [councils.id],
    }),
  }),
);

/* -------------------------------------------------------------- events */

export const eventsRelations = relations(events, ({ one, many }) => ({
  sessions: many(eventSessions),
  ticketTypes: many(ticketTypes),
  sponsorTiers: many(sponsorTiers),
  registrations: many(registrations),
  sponsorships: many(eventSponsorships),
  documents: many(documents),
  council: one(councils, {
    fields: [events.councilId],
    references: [councils.id],
  }),
  pairedSponsorshipEvent: one(events, {
    fields: [events.pairedSponsorshipEventId],
    references: [events.id],
    relationName: "pairedSponsorship",
  }),
}));

export const eventSessionsRelations = relations(eventSessions, ({ one }) => ({
  event: one(events, {
    fields: [eventSessions.eventId],
    references: [events.id],
  }),
}));

export const ticketTypesRelations = relations(
  ticketTypes,
  ({ one, many }) => ({
    event: one(events, {
      fields: [ticketTypes.eventId],
      references: [events.id],
    }),
    registrations: many(registrations),
  }),
);

export const sponsorTiersRelations = relations(
  sponsorTiers,
  ({ one, many }) => ({
    event: one(events, {
      fields: [sponsorTiers.eventId],
      references: [events.id],
    }),
    sponsorships: many(eventSponsorships),
  }),
);

export const registrationsRelations = relations(registrations, ({ one }) => ({
  event: one(events, {
    fields: [registrations.eventId],
    references: [events.id],
  }),
  ticketType: one(ticketTypes, {
    fields: [registrations.ticketTypeId],
    references: [ticketTypes.id],
  }),
  contact: one(contacts, {
    fields: [registrations.contactId],
    references: [contacts.id],
  }),
  organization: one(organizations, {
    fields: [registrations.organizationId],
    references: [organizations.id],
  }),
}));

export const eventSponsorshipsRelations = relations(
  eventSponsorships,
  ({ one }) => ({
    event: one(events, {
      fields: [eventSponsorships.eventId],
      references: [events.id],
    }),
    tier: one(sponsorTiers, {
      fields: [eventSponsorships.sponsorTierId],
      references: [sponsorTiers.id],
    }),
    organization: one(organizations, {
      fields: [eventSponsorships.organizationId],
      references: [organizations.id],
    }),
    contact: one(contacts, {
      fields: [eventSponsorships.contactId],
      references: [contacts.id],
    }),
  }),
);

/* ------------------------------------------------------------- finance */

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [invoices.organizationId],
    references: [organizations.id],
  }),
  contact: one(contacts, {
    fields: [invoices.contactId],
    references: [contacts.id],
  }),
  membership: one(memberships, {
    fields: [invoices.membershipId],
    references: [memberships.id],
  }),
  event: one(events, { fields: [invoices.eventId], references: [events.id] }),
  lines: many(invoiceLines),
  allocations: many(paymentAllocations),
  refunds: many(refunds),
}));

export const invoiceLinesRelations = relations(invoiceLines, ({ one }) => ({
  invoice: one(invoices, {
    fields: [invoiceLines.invoiceId],
    references: [invoices.id],
  }),
}));

export const paymentsRelations = relations(payments, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [payments.organizationId],
    references: [organizations.id],
  }),
  contact: one(contacts, {
    fields: [payments.contactId],
    references: [contacts.id],
  }),
  allocations: many(paymentAllocations),
  refunds: many(refunds),
}));

export const paymentAllocationsRelations = relations(
  paymentAllocations,
  ({ one }) => ({
    payment: one(payments, {
      fields: [paymentAllocations.paymentId],
      references: [payments.id],
    }),
    invoice: one(invoices, {
      fields: [paymentAllocations.invoiceId],
      references: [invoices.id],
    }),
  }),
);

export const refundsRelations = relations(refunds, ({ one }) => ({
  invoice: one(invoices, {
    fields: [refunds.invoiceId],
    references: [invoices.id],
  }),
  payment: one(payments, {
    fields: [refunds.paymentId],
    references: [payments.id],
  }),
  organization: one(organizations, {
    fields: [refunds.organizationId],
    references: [organizations.id],
  }),
}));

/* ----------------------------------------------------------- documents */

export const documentsRelations = relations(documents, ({ one, many }) => ({
  event: one(events, { fields: [documents.eventId], references: [events.id] }),
  council: one(councils, {
    fields: [documents.councilId],
    references: [councils.id],
  }),
  uploadedByContact: one(contacts, {
    fields: [documents.uploadedByContactId],
    references: [contacts.id],
  }),
  downloads: many(documentDownloads),
}));

export const documentDownloadsRelations = relations(
  documentDownloads,
  ({ one }) => ({
    document: one(documents, {
      fields: [documentDownloads.documentId],
      references: [documents.id],
    }),
    contact: one(contacts, {
      fields: [documentDownloads.contactId],
      references: [contacts.id],
    }),
  }),
);

export const contactFieldsRelations = relations(contactFields, () => ({}));
