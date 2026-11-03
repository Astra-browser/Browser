// Launcher panel: the floating search surface.
//
// The golden `launcher` screen wires `launcher_search`, so this is the one
// screen where results genuinely arrive: a history hit and a search row. Row
// execution still ends at an unrouted host command, so the assertions cover
// the list model (options, sections, live-region count), roving selection and
// the Escape/menu keyboard path rather than a navigation.
import { expect, test } from "../../ui/app/node_modules/playwright/test.mjs";
import { openScreen, trackRuntime } from "./support.ts";

test.describe("launcher", () => {
  test("answers the seeded query with grouped, counted results", async ({ page }) => {
    await openScreen(page, "launcher");

    const field = page.getByRole("combobox", { name: "Search or enter an address" });
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("read");
    await expect(field).toHaveAttribute("aria-expanded", "true");

    const list = page.getByRole("listbox", { name: "Search results" });
    await expect(list).toBeVisible();
    await expect(list.getByRole("group", { name: "History" })).toBeVisible();
    await expect(list.getByRole("group", { name: "Search" })).toBeVisible();
    await expect(page.getByRole("option")).toHaveCount(2);
    await expect(list.getByRole("option", { name: /Beacon Messenger/ })).toBeVisible();
    await expect(list.getByRole("option", { name: /read — compass search/ })).toBeVisible();

    // The count is announced, not just painted.
    await expect(page.getByRole("status").first()).toContainText("Results: 2");
  });

  test("ArrowDown/ArrowUp move the active row without leaving the field", async ({ page }) => {
    await openScreen(page, "launcher");
    const field = page.getByRole("combobox", { name: "Search or enter an address" });
    await expect(field).toHaveAttribute("aria-activedescendant", /launcher-results-option-0$/);

    await page.keyboard.press("ArrowDown");
    await expect(field).toHaveAttribute("aria-activedescendant", /launcher-results-option-1$/);
    await page.keyboard.press("ArrowUp");
    await expect(field).toHaveAttribute("aria-activedescendant", /launcher-results-option-0$/);
    await expect(field).toBeFocused();
  });

  test("typing re-answers: the search row follows the new line", async ({ page }) => {
    await openScreen(page, "launcher");
    const field = page.getByRole("combobox", { name: "Search or enter an address" });

    await field.fill("");
    await field.pressSequentially("ledger", { delay: 15 });
    await expect(page.getByRole("option", { name: /ledger — compass search/ })).toBeVisible();
    await expect(page.getByRole("status").first()).toContainText("Results: 2");
  });

  test("Enter runs the active row and keeps the panel usable", async ({ page }) => {
    const runtime = trackRuntime(page);
    await openScreen(page, "launcher");
    const field = page.getByRole("combobox", { name: "Search or enter an address" });

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(field).toBeVisible();
    expect(runtime.pageErrors).toEqual([]);
  });

  test("Escape clears the typed line; the window dismissal stays native", async ({ page }) => {
    await openScreen(page, "launcher");
    const field = page.getByRole("combobox", { name: "Search or enter an address" });
    await expect(field).toHaveValue("read");

    await page.keyboard.press("Escape");
    // Spotlight order: first press clears, second asks to put the window away.
    await expect(field).toHaveValue("");
    await expect(field).toBeFocused();
  });

  test("the Actions sheet is a named menu that Escape closes", async ({ page }) => {
    await openScreen(page, "launcher");
    await page.getByRole("button", { name: /^Actions/ }).click();

    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    // The row names carry their accelerator glyph ("Open↵"), so assert the
    // labels as content rather than as exact accessible names.
    const items = menu.getByRole("menuitem");
    await expect(items).toHaveCount(3);
    await expect(items.first()).toContainText("Open");
    await expect(menu).toContainText("Open in Background");
    await expect(menu).toContainText("Copy Link");

    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  });
});
