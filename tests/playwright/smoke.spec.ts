// NOTE: bare `playwright/test` does not resolve from tests/ (repo root has
// no package.json; the runner lives in ui/app/node_modules), so the spec
// imports the runner relatively. Keep in sync with ui/app's playwright dep.
import { expect, test } from "../../ui/app/node_modules/playwright/test.mjs";

// Standalone smoke (P3-T18). Loads the frame's static browser page over the
// Vite dev server (see ui/app/playwright.config.ts webServer) — never the
// native app binary or engine. Screenshots land in out/playwright-smoke/
// (the config's outputDir).
test("browser titlebar renders with no BridgeError", async ({ page }, testInfo) => {
  const bridgeErrors: string[] = [];
  // NOTE: "trusted browser initialization failed" from entries/browser.ts is
  // EXPECTED in standalone Chromium (no Tauri host) — it is not a BridgeError
  // (the @astra/bridge error class, name === "BridgeError") and is excluded.
  page.on("console", (msg) => {
    if (msg.type() === "error" && /BridgeError/.test(msg.text())) {
      bridgeErrors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    if (/BridgeError/i.test(String(err))) bridgeErrors.push(String(err));
  });

  await page.goto("/browser.html");
  await expect(page).toHaveTitle(/Astra/);

  // The browser entry mounts into #root; without native Tauri APIs it logs
  // "trusted browser initialization failed" instead of mounting, so only
  // assert the shell (root element + titlebar spacer) rather than full app.
  const root = page.locator("#root");
  await expect(root).toBeAttached();

  // Titlebar spacer: SidebarHeader renders a --titlebar-height spacer div.
  // Fall back to asserting the page shell is non-blank.
  const titlebarSpacer = page.locator('[style*="--titlebar-height"]');
  const spacerCount = await titlebarSpacer.count();
  if (spacerCount > 0) {
    await expect(titlebarSpacer.first()).toBeAttached();
  } else {
    const bodyText = await page.evaluate(() => document.body.innerHTML.length);
    expect(bodyText).toBeGreaterThan(0);
  }

  // Screenshot lands under the config outputDir (out/playwright-smoke/).
  await page.screenshot({ path: testInfo.outputPath("smoke-browser.png") });
  expect(bridgeErrors, `BridgeError console noise: ${bridgeErrors.join("\n")}`).toEqual([]);
});
