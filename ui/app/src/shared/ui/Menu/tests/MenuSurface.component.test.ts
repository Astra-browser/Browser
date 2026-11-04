import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import "$styles/global.css";
import Host from "./MenuSurfaceHost.svelte";

// The paper chrome's menu recipe: 12px panel, 6px padding, 34px rows, 8px row
// corners, 13px labels, 11px hints and one soft drop. Pinned here because the
// surface is shared by every menu, pop-up and dropdown in the product.
const open = async () => {
  const screen = await render(Host);
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await expect.poll(() => document.querySelector('.ui-menu[data-state="open"]')).not.toBeNull();
  return screen;
};

const panel = () => document.querySelector<HTMLElement>('.ui-menu[data-state="open"]')!;
const item = (name: string) =>
  [...panel().querySelectorAll<HTMLElement>(".ui-menu-item")].find((row) =>
    row.textContent?.includes(name),
  )!;

test("the menu surface is a 12px, 6px-padded sheet with one soft drop", async () => {
  const screen = await open();
  const style = getComputedStyle(panel());
  expect(style.borderRadius).toBe("12px");
  expect(style.paddingTop).toBe("6px");
  expect(style.paddingInlineStart).toBe("6px");
  // One rim plus one drop. A second inset highlight would stack the edge.
  expect(style.boxShadow).not.toBe("none");
  expect(style.boxShadow).not.toContain("inset");
  await screen.unmount();
});

test("a row is 34px high with an 8px corner and a 13px label", async () => {
  const screen = await open();
  const row = item("Copy");
  const style = getComputedStyle(row);
  expect(style.minHeight).toBe("34px");
  expect(style.borderRadius).toBe("8px");
  expect(style.fontSize).toBe("13px");
  expect(style.paddingInlineStart).toBe("8px");
  await screen.unmount();
});

test("a shortcut is an 11px hint held to the trailing edge", async () => {
  const screen = await open();
  const row = item("Copy");
  const hint = row.querySelector<HTMLElement>(".ui-menu-hint")!;
  expect(getComputedStyle(hint).fontSize).toBe("11px");
  // Auto margin pushes it to the row's inline end, inside the 8px row inset.
  expect(hint.getBoundingClientRect().right).toBeCloseTo(row.getBoundingClientRect().right - 8, 0);
  await screen.unmount();
});

test("a separator is a 1px rule with a 4px break", async () => {
  const screen = await open();
  const style = getComputedStyle(panel().querySelector<HTMLElement>(".ui-menu-separator")!);
  expect(style.height).toBe("1px");
  expect(style.marginBlockStart).toBe("4px");
  expect(style.marginBlockEnd).toBe("4px");
  await screen.unmount();
});
