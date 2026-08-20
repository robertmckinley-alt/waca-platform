import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end and accessibility suite.
 *
 * Runs against a PRODUCTION build (`next build && next start`), not the dev
 * server: dev-only overlays and unminified error boundaries inject markup that
 * neither axe nor a real member ever sees, and dev-mode double-rendering hides
 * the sort of hydration bug this suite exists to catch.
 *
 * Workers are pinned to 1. These tests write to the same database — creating
 * an event, registering a contact, raising an invoice — and a parallel run
 * would race on the invoice-number sequence and on the seeded fixtures.
 */
/**
 * Auth.js builds its post-sign-in redirect from AUTH_URL. If that points at
 * :3000 while the harness serves :3100, every signIn() lands on a dead port
 * and the whole suite fails with ERR_CONNECTION_REFUSED — which looks like a
 * broken app and is not. The harness owns the origin and tells Auth.js.
 */
const E2E_PORT = process.env.E2E_PORT ?? "3100";
const E2E_ORIGIN = `http://127.0.0.1:${E2E_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? E2E_ORIGIN,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npx next start -p ${E2E_PORT}`,
        url: `${E2E_ORIGIN}/login`,
        reuseExistingServer: true,
        timeout: 120_000,
        env: {
          ...process.env,
          AUTH_URL: E2E_ORIGIN,
          AUTH_TRUST_HOST: "true",
          NEXT_PUBLIC_APP_URL: E2E_ORIGIN,
        } as Record<string, string>,
      },
});
