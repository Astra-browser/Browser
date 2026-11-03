import { defineConfig, devices } from "playwright/test";

// Standalone UI lane only (P3-T18). This config serves the frame's mock-backed
// pages with Vite and drives them with system Chromium. It must NEVER launch
// the native app binary (obj-astra-linux / dist/bin/firefox) or the engine —
// the in-Firefox lane stays with marionette/geckodriver (see plan §5.3 and
// docs/astra/PLAYWRIGHT.md).
//
// Which pages: `golden.html?screen=…` (ui/app/golden/), not `browser.html`.
// The production entry (src/entries/browser.ts) refuses to mount unless the
// Tauri window label is "main", so on a plain dev server it only logs
// "trusted browser initialization failed" and paints nothing. The golden entry
// mounts the same component graph with `@tauri-apps/api/*` aliased to
// deterministic mocks (vite.golden.config.ts), which is what gives the lane a
// real UI to assert on. Its screens cover shell, spaces, newtab, launcher,
// tasks, notes, time and settings.
//
// Port: vite.frame.ts pins the frame dev server to 1420; the golden config
// defaults to 1421, and this webServer overrides it to 1420 so one lane owns
// one port (the task brief's 127.0.0.1:1420).
export default defineConfig({
  testDir: "../../tests/playwright",
  outputDir: "../../out/playwright-smoke",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "../../out/playwright-report", open: "never" }],
    ["junit", { outputFile: "../../out/playwright-smoke/junit.xml" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:1420",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], headless: true },
    },
  ],
  webServer: {
    // The golden build aliases the Tauri modules; `--port` keeps it on the
    // lane's one port instead of the config's 1421 default.
    command: "bunx vite --config vite.golden.config.ts --host 127.0.0.1 --port 1420 --strictPort",
    url: "http://127.0.0.1:1420/golden.html",
    reuseExistingServer: true,
    timeout: 90_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
