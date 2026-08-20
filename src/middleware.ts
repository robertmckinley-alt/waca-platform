import type { NextFetchEvent, NextRequest } from "next/server";
import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

/**
 * Edge middleware. Imports the edge-safe config only -- no DB driver here.
 *
 *   /admin/*  requires role admin or staff
 *   /portal/* requires any authenticated user
 *
 * The gate itself lives in authConfig.callbacks.authorized so the same rule
 * is reused by `auth()` on the server. Exported as an explicit function
 * because Next's build-time analyser does not recognise a destructured
 * `export const { auth: middleware }`.
 */
const { auth } = NextAuth(authConfig);

export default function middleware(req: NextRequest, ev: NextFetchEvent) {
  return (auth as unknown as (
    r: NextRequest,
    e: NextFetchEvent,
  ) => ReturnType<typeof auth>)(req, ev);
}

export const config = {
  matcher: ["/admin/:path*", "/portal/:path*"],
};
