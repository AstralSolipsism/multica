import { defineConfig } from "@playwright/test";

// Stage 5 (OL-1252) one-shot screenshot tour. Same fixed endpoints and
// server lifecycle as playwright.retained.config.ts; test-retained-e2e.sh has
// already built the server and web app.
export default defineConfig({
  testDir: "./",
  testMatch: ["stage5-shots.spec.ts"],
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  outputDir: "../../../test-results/stage5-shots/results",
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:13000",
    headless: true,
    trace: "off",
    screenshot: "off",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: [
    {
      command: "./bin/retained-e2e-server",
      cwd: "server",
      url: "http://127.0.0.1:18080/health",
      reuseExistingServer: true,
      timeout: 60_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
    {
      command: "pnpm --filter @multica/web exec next start --hostname 127.0.0.1 --port 13000",
      url: "http://127.0.0.1:13000/login",
      reuseExistingServer: true,
      timeout: 60_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
  ],
});
