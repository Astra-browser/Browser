// Shared helpers for the standalone UI lane (P3-T18).
//
// Scope: this lane drives the frame's MOCK-BACKED pages only — the golden
// entry (`golden.html?screen=…`) that aliases `@tauri-apps/api/*` to
// deterministic fixtures (`ui/app/golden/`). It never launches the native
// binary or the engine; the in-Firefox lane stays with marionette (see
// docs/astra/PLAYWRIGHT.md).
//
// D-36 note: cargo-culting a native command is expected to change nothing
// here. The UI renders its projection, and in this harness the projection is
// frozen at what the screen seeded. Assertions therefore cover what the
// interface owns — structure, roles, names, keyboard paths, focus, layout,
// local state transitions, empty/error rendering — and a click whose effect
// belongs to the host is asserted only to leave the UI healthy (no crash, no
// lost chrome).
//
// The runner is imported relatively because the repo root has no
// package.json, so bare `playwright/test` does not resolve from tests/.
import { expect, type Page } from "../../ui/app/node_modules/playwright/test.mjs";

/** Every deterministic screen the golden entry can boot. */
export type Screen =
  | "shell"
  | "spaces"
  | "newtab"
  | "launcher"
  | "tasks"
  | "notes"
  | "time"
  | "settings";

export const DESKTOP = { width: 1280, height: 800 } as const;

/**
 * Console/page noise the standalone harness produces on purpose and that must
 * never fail a UI assertion:
 *   · "trusted browser initialization failed" — entries/*.ts refuse to mount
 *     without a Tauri host on the plain dev pages (not the golden entry).
 *   · "[golden] unmocked invoke: X" — a command the golden router does not
 *     fixture. Indicator of a harness gap, reported separately, not a UI bug.
 */
const EXPECTED_NOISE = [
  /trusted browser initialization failed/,
  /\[golden\] unmocked invoke: /,
];

export type Runtime = {
  /** Uncaught exceptions (pageerror). Never expected. */
  pageErrors: string[];
  /** console.error lines, including the harness's own unmocked notices. */
  consoleErrors: string[];
  /** console errors that are not sanctioned harness noise. */
  unexpectedConsole: () => string[];
};

/** Start recording runtime faults for a page. Call before `goto`. */
export function trackRuntime(page: Page): Runtime {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error: Error) => pageErrors.push(String(error)));
  page.on("console", (message: { type: () => string; text: () => string }) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  return {
    pageErrors,
    consoleErrors,
    unexpectedConsole: () => consoleErrors.filter((line) => !EXPECTED_NOISE.some((re) => re.test(line))),
  };
}

/**
 * Boot one golden screen and wait for the screen's own settle signal
 * (`data-golden="ready"`, set by golden/screens.ts after the fixtures are
 * painted). Polling, never a fixed sleep.
 */
export async function openScreen(page: Page, screen: Screen): Promise<void> {
  const response = await page.goto(`/golden.html?screen=${screen}`);
  expect(response?.status(), `golden screen ${screen} HTTP status`).toBe(200);
  await expect(page.locator("html")).toHaveAttribute("data-golden", "ready", {
    timeout: 30_000,
  });
}

/** The sidebar landmark every browser screen shares. */
export function sidebar(page: Page) {
  return page.getByRole("complementary", { name: "Browser sidebar" });
}

/** The New Tab surface (role=region via its accessible name). */
export function newTab(page: Page) {
  return page.getByRole("region", { name: "New tab" });
}

/** The New Tab search field. */
export function newTabField(page: Page) {
  return newTab(page).getByRole("combobox");
}

/** Settings' category column. */
export function settingsNav(page: Page) {
  return page.getByRole("navigation", { name: "Settings" });
}

/** Settings' content pane. */
export function settingsPane(page: Page) {
  return page.getByRole("region", { name: "Settings" });
}

/**
 * Every interactive control must expose a name, and every image must carry
 * alt text (empty is fine for decorative rasters). Shared a11y smoke.
 */
export async function unnamedControls(page: Page): Promise<{
  buttons: string[];
  images: number;
  links: string[];
}> {
  return page.evaluate(() => {
    const name = (element: Element) =>
      (element.getAttribute("aria-label") ?? element.getAttribute("title") ?? element.textContent ?? "")
        .trim()
        .slice(0, 60);
    const buttons = [...document.querySelectorAll("button")]
      .filter((button) => name(button) === "")
      .map((button) => button.outerHTML.slice(0, 80));
    const links = [...document.querySelectorAll("a")]
      .filter((link) => name(link) === "")
      .map((link) => link.outerHTML.slice(0, 80));
    return {
      buttons,
      links,
      images: document.querySelectorAll("img:not([alt])").length,
    };
  });
}
