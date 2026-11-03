// Standalone smoke (P3-T18): the frame's real UI graph, booted from the
// golden entry (`golden.html?screen=shell`) which aliases `@tauri-apps/api/*`
// to deterministic mocks. It never launches the native app binary or the
// engine (see ui/app/playwright.config.ts and docs/astra/PLAYWRIGHT.md).
//
// This is deliberately the smallest check in the lane: it proves the document
// boots, the shell mounts, and nothing throws the bridge's own error class.
// The behaviour lives in the per-surface specs beside it.
import { expect, test } from "../../ui/app/node_modules/playwright/test.mjs";
import { newTabField, openScreen, sidebar, trackRuntime } from "./support.ts";

test("the shell boots with no BridgeError and no uncaught exception", async ({ page }, testInfo) => {
  // "trusted browser initialization failed" from entries/browser.ts is
  // EXPECTED on the plain dev pages (no Tauri host); the golden entry mounts
  // with mocks and must not produce it, nor any @astra/bridge BridgeError.
  const bridgeErrors: string[] = [];
  const runtime = trackRuntime(page);
  page.on("console", (message) => {
    if (message.type() === "error" && /BridgeError/.test(message.text())) {
      bridgeErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    if (/BridgeError/i.test(String(error))) bridgeErrors.push(String(error));
  });

  await openScreen(page, "shell");

  await expect(page).toHaveTitle(/Astra/);
  await expect(sidebar(page)).toBeVisible();
  await expect(newTabField(page)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Address and search" })).toBeVisible();

  expect(runtime.pageErrors, `uncaught exceptions: ${runtime.pageErrors.join("\n")}`).toEqual([]);
  expect(bridgeErrors, `BridgeError noise: ${bridgeErrors.join("\n")}`).toEqual([]);

  // Artifact for visual review (out/ is gitignored).
  await page.screenshot({ path: testInfo.outputPath("smoke-shell.png") });
});
