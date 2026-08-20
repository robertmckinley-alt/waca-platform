import type { NextAuthConfig } from "next-auth";

/**
 * EDGE-SAFE half of the Auth.js config.
 *
 * The middleware runs on the edge runtime and must not pull in the database
 * driver, so it imports THIS file only. The full config (adapter, Resend,
 * credentials) lives in src/auth.ts and runs in the Node runtime.
 */
export const authConfig = {
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
    verifyRequest: "/login/check-email",
    error: "/login/error",
  },
  trustHost: true,
  providers: [],
  callbacks: {
    /**
     * Route protection.
     *   /admin/*  -> admin | staff
     *   /portal/* -> any authenticated user
     * Everything else is public.
     */
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;
      const role = auth?.user?.role;

      if (pathname.startsWith("/admin")) {
        return role === "admin" || role === "staff";
      }
      if (pathname.startsWith("/portal")) {
        return Boolean(auth?.user);
      }
      return true;
    },

    jwt({ token, user }) {
      if (user) {
        token.role = user.role ?? "member";
        token.contactId = user.contactId ?? null;
        token.organizationId = user.organizationId ?? null;
      }
      return token;
    },

    session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub ?? "";
        session.user.role = token.role ?? "member";
        session.user.contactId = token.contactId ?? null;
        session.user.organizationId = token.organizationId ?? null;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
