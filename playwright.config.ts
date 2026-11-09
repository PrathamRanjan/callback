import { defineConfig, devices } from "@playwright/test";

/**
 * Browser journeys against a real server. By default it starts its own: a fresh PGlite database, the rules brain
 * (deterministic, no model key) and the PayPal sandbox from .env if present. Point E2E_URL at a running server to
 * reuse it instead. Run with `npm run e2e`.
 */
const port = Number(process.env.E2E_PORT ?? 3511);
const url = process.env.E2E_URL ?? `http://localhost:${port}`;

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: url, trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  webServer: process.env.E2E_URL
    ? undefined
    : {
        command: `rm -rf ./data/pglite-e2e && DATABASE_URL= OPENAI_API_KEY= AI_PROVIDER=rules TELEGRAM_BOT_TOKEN= PORT=${port} APP_URL=${url} PGLITE_PATH=./data/pglite-e2e node --env-file-if-exists=.env dist/main.js`,
        url: `${url}/healthz`,
        reuseExistingServer: false,
        timeout: 60_000,
      },
});
