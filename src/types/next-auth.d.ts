import type { DefaultSession } from "next-auth";

export type WacaRole = "admin" | "staff" | "bundle_admin" | "member";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: WacaRole;
      contactId: string | null;
      organizationId: string | null;
    } & DefaultSession["user"];
  }

  interface User {
    role?: WacaRole;
    contactId?: string | null;
    organizationId?: string | null;
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    role?: WacaRole;
    contactId?: string | null;
    organizationId?: string | null;
  }
}
