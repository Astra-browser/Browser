// New Tab search field: the one search input the New Tab page owns.
//
// The golden `newtab` screen does not answer `newtab_search` (its results
// arrive as native events), so the result sheet never opens here. That is the
// expected unwired state (D-36): what this spec covers is the field's own
// contract — focus, the clear control, Escape's two steps, Enter, IME and
// arrow keys never losing the typed line.
import { expect, test } from "../../ui/app/node_modules/playwright/test.mjs";
import { newTab, newTabField, openScreen, trackRuntime } from "./support.ts";

test.describe("New Tab search field", () => {
  test("arrives focused, with no clear control until something is typed", async ({ page }) => {
    await openScreen(page, "newtab");
    const field = newTabField(page);

    await expect(field).toBeFocused();
    await expect(field).toHaveValue("");
    await expect(field).toHaveAttribute("aria-expanded", "false");
    await expect(newTab(page).getByRole("button", { name: /clear/i })).toHaveCount(0);

    await field.pressSequentially("beacon", { delay: 15 });
    await expect(field).toHaveValue("beacon");
    await expect(newTab(page).getByRole("button", { name: /clear/i })).toBeVisible();
  });

  test("Escape puts the sheet away first, then clears the line", async ({ page }) => {
    await openScreen(page, "newtab");
    const field = newTabField(page);
    await field.pressSequentially("harbor", { delay: 15 });

    await page.keyboard.press("Escape");
    await expect(field).toHaveValue("harbor");

    await page.keyboard.press("Escape");
    await expect(field).toHaveValue("");
    await expect(newTab(page).getByRole("button", { name: /clear/i })).toHaveCount(0);
  });

  test("the clear control empties the field and returns focus", async ({ page }) => {
    await openScreen(page, "newtab");
    const field = newTabField(page);
    await field.pressSequentially("northwind", { delay: 15 });

    await newTab(page).getByRole("button", { name: /clear/i }).click();
    await expect(field).toHaveValue("");
    await expect(field).toBeFocused();
  });

  test("Enter submits the typed line without breaking the field", async ({ page }) => {
    // Submitting asks the host to open what was typed; the command is
    // unrouted in this harness, so the UI contract is "the line survives".
    const runtime = trackRuntime(page);
    await openScreen(page, "newtab");
    const field = newTabField(page);
    await field.pressSequentially("beacon.example", { delay: 15 });

    await page.keyboard.press("Enter");
    await expect(field).toHaveValue("beacon.example");
    await expect(field).toBeFocused();
    expect(runtime.pageErrors).toEqual([]);
  });

  test("arrow keys do not eat an unanswered query", async ({ page }) => {
    await openScreen(page, "newtab");
    const field = newTabField(page);
    await field.pressSequentially("compass", { delay: 15 });

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await expect(field).toHaveValue("compass");
    // No answer arrived, so nothing may claim to be the active row.
    await expect(field).not.toHaveAttribute("aria-activedescendant", /.*/i);
  });

  test("IME composition lands in the field and Enter during composition is ignored", async ({
    page,
  }) => {
    await openScreen(page, "newtab");
    const field = newTabField(page);
    await field.click();

    // A real IME key sequence: compositionstart → input(isComposing) →
    // compositionend. The surface must accept the composed text and must not
    // treat the committing Enter as a submit.
    await field.evaluate((element: HTMLInputElement) => {
      element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      element.value = "にほん";
      element.dispatchEvent(
        new InputEvent("input", { bubbles: true, data: "にほん", isComposing: true }),
      );
      element.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true, data: "にほん" }),
      );
    });

    await expect(field).toHaveValue("にほん");

    await field.evaluate((element: HTMLInputElement) => {
      element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }),
      );
    });
    await expect(field).toHaveValue("にほん");
    await expect(newTab(page).getByRole("button", { name: /clear/i })).toBeVisible();
  });
});
