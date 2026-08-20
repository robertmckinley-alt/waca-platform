import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";
import { userRoleEnum } from "./enums";

/**
 * Auth.js v5 tables (Drizzle adapter shape) plus WACA extensions.
 *
 * `users` is the login identity. The *person* is `contacts`. A contact may
 * exist with no user (imported member who has never logged in); a user must
 * eventually be linked to a contact to see any portal data.
 *
 * The FK from users -> contacts is added in a follow-up migration statement
 * rather than declared here, to avoid a circular table reference at the
 * Drizzle level. See relations in ./index.ts.
 */
export const users = pgTable(
  "users",
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text(),
    email: text().notNull(),
    emailVerified: timestamp({ withTimezone: true, mode: "date" }),
    image: text(),

    /** Argon2id/bcrypt hash for the credentials provider. Null = magic link only. */
    passwordHash: text(),

    role: userRoleEnum().notNull().default("member"),

    /** Person this login belongs to. Null until an admin links it. */
    contactId: uuid(),

    isActive: boolean().notNull().default(true),
    lastLoginAt: timestamp({ withTimezone: true, mode: "date" }),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("users_email_lower_uq").on(t.email),
    index("users_role_idx").on(t.role),
    index("users_contact_id_idx").on(t.contactId),
  ],
);

export const accounts = pgTable(
  "accounts",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text().$type<AdapterAccountType>().notNull(),
    provider: text().notNull(),
    providerAccountId: text().notNull(),
    refresh_token: text(),
    access_token: text(),
    expires_at: integer(),
    token_type: text(),
    scope: text(),
    id_token: text(),
    session_state: text(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.providerAccountId] }),
    index("accounts_user_id_idx").on(t.userId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    sessionToken: text().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expires: timestamp({ withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text().notNull(),
    token: text().notNull(),
    expires: timestamp({ withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

export const authenticators = pgTable(
  "authenticators",
  {
    credentialID: text().notNull().unique(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerAccountId: text().notNull(),
    credentialPublicKey: text().notNull(),
    counter: integer().notNull(),
    credentialDeviceType: text().notNull(),
    credentialBackedUp: boolean().notNull(),
    transports: text(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.credentialID] })],
);
