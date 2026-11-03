// The shell at the three reference widths. The product has no breakpoints:
// the column keeps its user-chosen width and the stage takes the rest, so the
// contract is that nothing overflows the document and the chrome stays
// reachable at every width.
import { expect, test } from "../../ui/app/node_modules/playwright/test.mjs";
import { newTab, newTabField, openScreen, sidebar } from "./support.ts";

type Measurable = { evaluate: (fn: () => unknown) => Promise<any> };

async function layout(page: Measurable) {
  return page.evaluate(() => {
    const doc = document.scrollingElement;
    const region = document.querySelector('section[aria-label="New tab"]');
    const box = region?.getBoundingClientRect();
    return {
      overflowX: doc ? doc.scrollWidth - doc.clientWidth : -1,
      region: box ? { left: box.left, right: box.right, width: box.width } : null,
      viewport: innerWidth,
    };
  });
}

for (const width of [1280, 768, 320]) {
  test.describe(`shell at ${width}px`, () => {
    test.use({ viewport: { width, height: 800 } });

    test("fills the viewport without horizontal overflow", async ({ page }, testInfo) => {
      await openScreen(page, "shell");

      const measured = await layout(page);
      expect(measured.viewport).toBe(width);
      expect(measured.overflowX, "document horizontal overflow").toBe(0);
      expect(measured.region, "New Tab region exists").not.toBeNull();
      const region = measured.region!;
      expect(region.width).toBeGreaterThan(0);
      expect(region.right).toBeLessThanOrEqual(width);
      expect(region.left).toBeGreaterThanOrEqual(0);

      await expect(sidebar(page)).toBeVisible();
      await expect(page.getByRole("button", { name: "Toggle sidebar" })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Address and search" })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Open tabs" })).toBeVisible();
      await expect(newTab(page)).toBeVisible();

      // Artifact for visual review (never committed: out/ is ignored).
      await page.screenshot({ path: testInfo.outputPath(`shell-${width}.png`), fullPage: true });
    });
  });
}

test.describe("shell at 1280px and 768px", () => {
  for (const width of [1280, 768]) {
    test(`the New Tab field keeps a usable width at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openScreen(page, "shell");
      const box = await newTabField(page).boundingBox();
      expect(box, "New Tab field has a box").not.toBeNull();
      expect(box!.width).toBeGreaterThan(120);
    });
  }
});

test.describe("shell at 320px", () => {
  test.use({ viewport: { width: 320, height: 800 } });

  test.fail("known limitation: the New Tab field collapses at 320px", async ({ page }) => {
    // The column keeps its 240px shape and the gutter eats the rest, so the
    // stage is 56px and notchWidth() clamps the field to 0
    // (ui/app/src/features/newtab/lib/ground.ts:17-19). Nothing in the product
    // collapses the sidebar by viewport (session/sidebar-mode.svelte.ts has no
    // width query), so 320px is unusable rather than merely tight. Remove
    // `test.fail` if a narrow-window shape lands.
    await openScreen(page, "shell");
    const box = await newTabField(page).boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(0);
  });
});
