// Spaces switcher: the menu the sidebar opens from the Spaces button.
// The golden `spaces` screen seeds three spaces and opens the menu, so the
// menu is the page's initial state.
import { expect, test } from "../../ui/app/node_modules/playwright/test.mjs";
import { openScreen } from "./support.ts";

const SPACE_NAMES = ["Personal", "Studio", "Reading"];

test.describe("spaces switcher", () => {
  test("lists every seeded space with the current one checked", async ({ page }) => {
    await openScreen(page, "spaces");

    const trigger = page.getByRole("button", { name: /^Spaces —/ });
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");

    const menu = page.getByRole("menu", { name: "Spaces" });
    await expect(menu).toBeVisible();
    const picks = menu.getByRole("menuitemradio");
    await expect(picks).toHaveCount(SPACE_NAMES.length);
    for (const name of SPACE_NAMES) {
      await expect(picks.filter({ hasText: name })).toHaveCount(1);
      await expect(menu.getByRole("menuitemradio", { name, exact: true })).toBeVisible();
    }

    const checked = await menu
      .locator('[role="menuitemradio"][aria-checked="true"]')
      .evaluateAll((elements) => elements.map((element) => element.textContent?.trim()));
    expect(checked).toHaveLength(1);
    expect(checked[0]).toContain("Personal");
  });

  test("each space offers an edit affordance named after it", async ({ page }) => {
    await openScreen(page, "spaces");
    const menu = page.getByRole("menu", { name: "Spaces" });

    for (const name of SPACE_NAMES) {
      await expect(menu.getByRole("button", { name: `Edit ${name}` })).toBeVisible();
    }
    await expect(menu.getByRole("menuitem", { name: "New Space" })).toBeVisible();
  });

  test("Escape puts the menu away and the trigger brings it back", async ({ page }) => {
    await openScreen(page, "spaces");
    const trigger = page.getByRole("button", { name: /^Spaces —/ });
    const menu = page.getByRole("menu", { name: "Spaces" });

    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    await trigger.click();
    await expect(menu).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
  });
});
