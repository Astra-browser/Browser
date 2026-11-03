// Settings: the category column, every section, in-page search, and the
// empty/error states that stand in when a view has nothing (or cannot borrow)
// real data.
//
// D-36: several sections read host projections the golden router does not
// fixture. A section that renders its heading and its failure/empty state is
// correct behaviour for this phase; a section whose script throws is not —
// that is tracked by the `known product bug` test below.
import { expect, test } from "../../ui/app/node_modules/playwright/test.mjs";
import { openScreen, settingsNav, settingsPane, trackRuntime } from "./support.ts";

const SECTIONS = [
  "General",
  "Appearance",
  "Tabs",
  "New Tab",
  "Search",
  "Privacy & security",
  "Time & focus",
  "Performance",
  "Profiles",
  "Work",
  "Models",
  "Skills",
  "Memory",
  "Site access",
  "Connections",
  "Features",
  "Keyboard & accessibility",
  "About",
];

test.describe("settings", () => {
  test("opens on General with the whole category column present", async ({ page }) => {
    await openScreen(page, "settings");

    const nav = settingsNav(page);
    await expect(nav).toBeVisible();
    await expect(nav.getByRole("button", { name: /^Sign in/ })).toBeVisible();
    for (const section of SECTIONS) {
      await expect(nav.getByRole("button", { name: section, exact: true })).toBeVisible();
    }

    await expect(settingsPane(page).getByRole("heading", { level: 1 })).toHaveText("General");
    await expect(page.getByRole("searchbox", { name: "Search settings" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to browsing" })).toBeVisible();
  });

  test("every section opens with its own heading", async ({ page }) => {
    await openScreen(page, "settings");
    const nav = settingsNav(page);
    const heading = settingsPane(page).getByRole("heading", { level: 1 });

    for (const section of SECTIONS) {
      await nav.getByRole("button", { name: section, exact: true }).click();
      await expect(heading, `section ${section} shows its own heading`).toHaveText(section);
    }
  });

  test("in-page search answers, empties, and clears", async ({ page }) => {
    await openScreen(page, "settings");
    const search = page.getByRole("searchbox", { name: "Search settings" });
    const pane = settingsPane(page);
    const heading = pane.getByRole("heading", { level: 1 });

    await search.fill("proxy");
    await expect(heading).toHaveText("Search results");
    const results = pane.locator(".settings-results button");
    await expect(results).toHaveCount(2);
    await expect(results.first()).toContainText(/Proxy/i);

    await search.fill("zzzqqq-nothing-matches");
    await expect(heading).toHaveText("Search results");
    await expect(results).toHaveCount(0);
    await expect(pane.getByText("No matching settings")).toBeVisible();

    await pane.getByRole("button", { name: "Clear search" }).click();
    await expect(search).toHaveValue("");
    await expect(heading).toHaveText("General");
  });

  test("choosing a search result opens the section that owns the setting", async ({ page }) => {
    await openScreen(page, "settings");
    const pane = settingsPane(page);

    await page.getByRole("searchbox", { name: "Search settings" }).fill("zoom");
    await pane.locator(".settings-results button").first().click();

    await expect(pane.getByRole("heading", { level: 1 })).toHaveText("Appearance");
    await expect(page.getByRole("searchbox", { name: "Search settings" })).toHaveValue("");
  });

  test("a view without a projection renders its retry card, not a blank page", async ({ page }) => {
    // Models reads work_models, which the golden router leaves unmocked; the
    // lazy view must surface its own failure state (UI rule: error + retry).
    await openScreen(page, "settings");
    await settingsNav(page).getByRole("button", { name: "Models", exact: true }).click();

    const pane = settingsPane(page);
    await expect(pane.getByText("This view could not be displayed.")).toBeVisible();
    await expect(pane.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test.fail(
    "known product bug: Appearance throws when zoom_call answers null",
    async ({ page }) => {
      // Repro: Settings → Appearance. `zoom_call` is answered with null (an
      // unrouted/unavailable command is the expected unwired state per D-36),
      // and src/domain/zoom/levels.svelte.ts:45 dereferences
      // `answer.value.kind` without a null guard, so the view throws instead
      // of rendering "zoom levels unavailable". Remove `test.fail` when the
      // null answer is tolerated.
      const runtime = trackRuntime(page);
      await openScreen(page, "settings");
      await settingsNav(page).getByRole("button", { name: "Appearance", exact: true }).click();
      const pane = settingsPane(page);
      await expect(pane.getByRole("heading", { level: 1 })).toHaveText("Appearance");
      // The card mounts after the heading; wait for its row so the async
      // `zoom_call` settlement has a chance to run before asserting.
      await expect(pane.getByText("Zoom levels", { exact: false })).toBeVisible();
      expect(runtime.pageErrors).toEqual([]);
    },
  );
});
