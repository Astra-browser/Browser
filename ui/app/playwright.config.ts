import { defineConfig, devices } from "playwright/test";

// Standalone UI lane only (P3-T18). This config serves the frame's static
// pages over Vite and drives them with system Chromium. It must NEVER launch
// the native app binary (obj-astra-linux / dist/bin/firefox) or the engine —
// the in-Firefox lane stays with marionette/geckodriver (see plan §5.3 and
// docs/astra/PLAYWRIGHT.md).
//
// Dev server port comes from vite.frame.ts (server.port = 1420). The task
// brief suggested 127.0.0.1:5199, but nothing in vite.config.ts /
// vite.frame.ts listens there, so baseURL targets the real dev port.
export default defineConfig({
  testDir: "../../tests/playwright",
  outputDir: "../../out/playwright-smoke",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:1420",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], headless: true },
    },
  ],
  webServer: {
    command: "bun run dev -- --host 127.0.0.1 --port 1420 --strictPort",
    url: "http://127.0.0.1:1420/browser.html",
    reuseExistingServer: true,
    timeout: 90_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
