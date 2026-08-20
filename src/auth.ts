import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq, sql } from "drizzle-orm";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Resend from "next-auth/providers/resend";
import { z } from "zod";

import { authConfig } from "./auth.config";
import { db } from "./db";
import {
  accounts,
  authenticators,
  contacts,
  sessions,
  users,
  verificationTokens,
} from "./db/schema";
import { verifyPassword } from "./lib/password";
import type { WacaRole } from "./types/next-auth";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

/**
 * Auth.js v5.
 *
 * Two ways in:
 *   1. Email magic link via Resend (the primary path for members).
 *   2. Email + password credentials (staff, and members who set one).
 *
 * Roles: admin | staff | bundle_admin | member, stored on users.role and
 * mirrored into the JWT so middleware can gate routes without a DB round trip.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
    authenticatorsTable: authenticators,
  }),
  providers: [
    Resend({
      apiKey: process.env.AUTH_RESEND_KEY ?? process.env.RESEND_API_KEY,
      from: process.env.EMAIL_FROM ?? "WACA <no-reply@example.org>",
      name: "Email magic link",
    }),
    Credentials({
      name: "Email and password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;

        const { email, password } = parsed.data;

        const [row] = await db
          .select({
            id: users.id,
            name: users.name,
            email: users.email,
            image: users.image,
            role: users.role,
            passwordHash: users.passwordHash,
            isActive: users.isActive,
            contactId: users.contactId,
            organizationId: contacts.organizationId,
          })
          .from(users)
          .leftJoin(contacts, eq(contacts.id, users.contactId))
          .where(sql`lower(${users.email}) = lower(${email})`)
          .limit(1);

        if (!row || !row.isActive) return null;
        if (!(await verifyPassword(password, row.passwordHash))) return null;

        await db
          .update(users)
          .set({ lastLoginAt: new Date() })
          .where(eq(users.id, row.id));

        return {
          id: row.id,
          name: row.name,
          email: row.email,
          image: row.image,
          role: row.role as WacaRole,
          contactId: row.contactId,
          organizationId: row.organizationId ?? null,
        };
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    /**
     * On a magic-link sign-in the adapter hands back the bare user row, so
     * top up the token from the database once.
     */
    async jwt({ token, user, trigger }) {
      if (user) {
        token.role = (user.role as WacaRole) ?? "member";
        token.contactId = user.contactId ?? null;
        token.organizationId = user.organizationId ?? null;
      }

      if (token.sub && (trigger === "signIn" || trigger === "update" || !token.role)) {
        const [row] = await db
          .select({
            role: users.role,
            contactId: users.contactId,
            organizationId: contacts.organizationId,
          })
          .from(users)
          .leftJoin(contacts, eq(contacts.id, users.contactId))
          .where(eq(users.id, token.sub))
          .limit(1);

        if (row) {
          token.role = row.role as WacaRole;
          token.contactId = row.contactId;
          token.organizationId = row.organizationId ?? null;
        }
      }

      return token;
    },
  },
});
