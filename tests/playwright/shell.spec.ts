// Browser shell: chrome structure, tab strip, sidebar modes, menus, a11y.
// Golden screen `shell` seeds four open tabs, three essentials and a focused
// New Tab (`ui/app/golden/screens.ts`).
import { expect, test } from "../../ui/app/node_modules/playwright/test.mjs";
import { newTab, newTabField, openScreen, sidebar, trackRuntime, unnamedControls } from "./support.ts";

test.describe("browser shell", () => {
  test("renders the three chrome columns with the seeded tab strip", async ({ page }) => {
    await openScreen(page, "shell");

    await expect(sidebar(page)).toBeVisible();
    await expect(newTab(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Toggle sidebar" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Address and search" })).toBeVisible();

    const openTabs = page.getByRole("navigation", { name: "Open tabs" });
    await expect(openTabs).toBeVisible();
    for (const title of [
      "Harbor code hosting",
      "Chorus - Web Player: Music for everyone",
      "compass search",
      "Atlas — Team wiki",
      "New Tab",
    ]) {
      await expect(openTabs.getByRole("button", { name: title, exact: true })).toBeVisible();
    }
    // Empty pinned/essentials lists render their `<nav>` hidden, so the
    // landmark only enters the a11y tree once it has rows.
    const pinned = page.getByRole("navigation", { name: "Pinned tabs" });
    if ((await pinned.count()) > 0) await expect(pinned).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Essentials" }).filter({ visible: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "New tab", exact: true })).toBeVisible();
  });

  test("exactly one tab is current and every close control names its tab", async ({ page }) => {
    await openScreen(page, "shell");

    await expect(page.locator('[aria-current="page"]')).toHaveCount(1);

    const openTabs = page.getByRole("navigation", { name: "Open tabs" });
    const rows = openTabs.getByRole("button", { name: /Close / });
    const closeNames = await rows.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("aria-label") ?? ""),
    );
    expect(closeNames.length).toBeGreaterThanOrEqual(4);
    for (const name of closeNames) {
      expect(name).toMatch(/^Close (Harbor|Chorus|compass|Atlas|New Tab)/);
    }
  });

  test("tab switch and close keep the strip healthy (host-projected)", async ({ page }) => {
    // D-36: selection and closing are host commands; this harness freezes the
    // projection, so the only UI contract here is "the strip survives the
    // intent" — the state change itself is deferred wiring.
    const runtime = trackRuntime(page);
    await openScreen(page, "shell");
    const openTabs = page.getByRole("navigation", { name: "Open tabs" });
    const before = await openTabs.getByRole("button", { name: /Close / }).count();

    await openTabs.getByRole("button", { name: "compass search", exact: true }).click();
    await expect(page.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(openTabs.getByRole("button", { name: /Close / })).toHaveCount(before);

    await openTabs.getByRole("button", { name: "Close compass search" }).click();
    await expect(openTabs.getByRole("button", { name: /Close / })).toHaveCount(before);
    expect(runtime.pageErrors).toEqual([]);
  });

  test("sidebar toggle hides the column and raises the edge", async ({ page }) => {
    const runtime = trackRuntime(page);
    await openScreen(page, "shell");
    const aside = sidebar(page);
    await expect(aside).not.toHaveAttribute("data-hidden", /.*/);

    await page.getByRole("button", { name: "Toggle sidebar" }).click();
    // Hidden mode is local to the session store; the column becomes the card
    // and the left edge is the only way back.
    await expect(aside).toHaveAttribute("data-hidden", "true");
    await expect(page.locator(".sidebar-edge")).toHaveCount(1);

    await page.getByRole("button", { name: "Toggle sidebar" }).click();
    await expect(aside).not.toHaveAttribute("data-hidden", /.*/);
    await expect(page.locator(".sidebar-edge")).toHaveCount(0);
    expect(runtime.pageErrors).toEqual([]);
  });

  test("Browse/Work radios reflect the projection and stay operable", async ({ page }) => {
    const runtime = trackRuntime(page);
    await openScreen(page, "shell");

    const group = page.getByRole("radiogroup", { name: "Switch between Browse and Work" });
    await expect(group).toBeVisible();
    await expect(group.getByRole("radio", { name: "Browse" })).toHaveAttribute("aria-checked", "true");
    await expect(group.getByRole("radio", { name: "Work" })).toHaveAttribute("aria-checked", "false");

    // Work mode is a host round-trip; the projection stays Browse here, so
    // the contract is that the switch neither throws nor loses the column.
    await group.getByRole("radio", { name: "Work" }).click();
    await expect(sidebar(page)).toBeVisible();
    await expect(page.getByRole("button", { name: /Tools —/ })).toBeVisible();
    expect(runtime.pageErrors).toEqual([]);
  });

  test("the resize handle widens the column (local sidebar mode)", async ({ page }) => {
    // The pointer drag is the one sidebar shape the UI owns end to end:
    // sidebar-mode.svelte.ts adopts the dragged width locally.
    await openScreen(page, "shell");
    const handle = page.getByRole("separator", { name: "Resize sidebar" });
    const box = await handle.boundingBox();
    expect(box, "resize handle has a box").not.toBeNull();
    if (!box) return;

    const before = (await sidebar(page).boundingBox())?.width ?? 0;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 64, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    await expect
      .poll(async () => (await sidebar(page).boundingBox())?.width ?? 0, {
        message: "sidebar widens after a rightward drag",
      })
      .toBeGreaterThan(before);
    // With room, the utilities settle back onto one line.
    await expect
      .poll(() => page.locator(".utility-bar").evaluate((bar) => getComputedStyle(bar).display))
      .toBe("flex");
  });

  test("the utility bar stays inside the column as it is dragged narrow", async ({ page }) => {
    await openScreen(page, "shell");
    const handle = page.getByRole("separator", { name: "Resize sidebar" });
    const box = await handle.boundingBox();
    expect(box, "resize handle has a box").not.toBeNull();
    if (!box) return;

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 50, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    const bar = page.locator(".utility-bar");
    await expect
      .poll(() => bar.evaluate((element) => getComputedStyle(element).display))
      .toBe("grid");
    const columns = await bar.evaluate(
      (element) => getComputedStyle(element).gridTemplateColumns.split(" ").length,
    );
    expect(columns).toBe(4);

    const aside = await sidebar(page).boundingBox();
    const barBox = await bar.boundingBox();
    expect(aside, "sidebar has a box").not.toBeNull();
    expect(barBox, "utility bar has a box").not.toBeNull();
    if (!aside || !barBox) return;
    expect(barBox.x).toBeGreaterThanOrEqual(aside.x - 0.5);
    expect(barBox.x + barBox.width).toBeLessThanOrEqual(aside.x + aside.width + 0.5);
  });

  test("one extension door opens an opaque hub over the tab list", async ({ page }) => {
    await openScreen(page, "shell");
    const aside = sidebar(page);
    // Menus opened from the column carry the column's opaque material policy,
    // so the tab list can never read through a panel's labels.
    await expect(aside).toHaveAttribute("data-menu-material", "opaque");
    await expect(page.getByRole("button", { name: "Extensions", exact: true })).toHaveCount(1);

    await page.getByRole("button", { name: "Extensions", exact: true }).click();
    const panel = page.locator(".extension-popover");
    await expect(panel).toHaveAttribute("data-open", "true");
    await expect(panel).toHaveAttribute("data-menu-material", "opaque");
    const background = await panel.evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(background).not.toMatch(/rgba\([^)]*,\s*0?\.\d+\)/u);
  });

  test("Tools menu opens a named menu and Escape puts it away", async ({ page }) => {
    await openScreen(page, "shell");
    const menu = page.getByRole("menu", { name: /Tools —/ });

    await page.getByRole("button", { name: /Tools —/ }).click();
    await expect(menu).toBeVisible();
    for (const item of ["Notes", "Tasks", "Time", "History", "Downloads", "Bookmarks", "Settings"]) {
      await expect(menu.getByRole("menuitem", { name: new RegExp(`^${item}`) })).toBeVisible();
    }

    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  });

  test("keyboard and ARIA smoke: skip link, landmarks, named controls", async ({ page }) => {
    await openScreen(page, "shell");

    const skip = page.getByRole("link", { name: /skip to content/i });
    await expect(skip).toHaveAttribute("href", "#astra-stage");
    await expect(page.locator("#astra-stage")).toHaveCount(1);

    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(sidebar(page)).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Open tabs" })).toBeVisible();

    const unnamed = await unnamedControls(page);
    expect(unnamed.buttons, `buttons without a name: ${unnamed.buttons.join("\n")}`).toEqual([]);
    expect(unnamed.links, `links without a name: ${unnamed.links.join("\n")}`).toEqual([]);
    expect(unnamed.images, "images without alt").toBe(0);

    // The address field is a form control with a real accessible name.
    const field = page.getByRole("textbox", { name: "Address and search" });
    await field.focus();
    await expect(field).toBeFocused();
    expect(await field.getAttribute("placeholder")).toBeTruthy();
  });

  test("New Tab search field takes focus on arrival", async ({ page }) => {
    await openScreen(page, "shell");
    await expect(newTabField(page)).toBeFocused();
  });
});
