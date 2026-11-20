import { expect, test } from "vitest";
import { render } from "vitest-browser-svelte";
import { userEvent } from "vitest/browser";
import "$styles/global.css";
import UtilityTrayHost from "./UtilityTrayHost.svelte";

const tray = (props: { warning?: string | null; pointerIn?: boolean } = {}) =>
  render(UtilityTrayHost, props);

/** The trigger by class: painted away it is `aria-hidden`, so the role query
 *  is only the honest one once it is revealed. */
const glyphOf = (screen: { container: HTMLElement }) => {
  const glyph = screen.container.querySelector<HTMLButtonElement>(".utilities-trigger");
  if (!glyph) throw new Error("no utilities trigger");
  return glyph;
};

test("one glyph, named for the panel it opens", async () => {
  const screen = await tray();
  const glyph = glyphOf(screen);
  expect(glyph.getAttribute("aria-label")).toBe("Site information");
  expect(glyph.getAttribute("aria-expanded")).toBe("false");
  expect(glyph.hasAttribute("title")).toBe(false);
});

test("a press opens the panel and takes the keyboard into it", async () => {
  const screen = await tray({ pointerIn: true });
  const glyph = screen.getByRole("button", { name: "Site information" });
  await glyph.click();
  await expect.element(glyph).toHaveAttribute("aria-expanded", "true");
  const panel = screen.getByRole("group", { name: "Site information" });
  await expect.element(panel.getByRole("button", { name: "Inside" })).toBeVisible();
  await expect.poll(() => panel.element().contains(document.activeElement)).toBe(true);
});

test("the keyboard opens it, Escape closes it, and focus returns to the glyph", async () => {
  const screen = await tray({ pointerIn: true });
  const glyph = screen.getByRole("button", { name: "Site information" });
  glyph.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(glyph).toHaveAttribute("aria-expanded", "true");
  const panel = screen.getByRole("group", { name: "Site information" });
  await expect.poll(() => panel.element().contains(document.activeElement)).toBe(true);

  await userEvent.keyboard("{Escape}");
  await expect.element(glyph).toHaveAttribute("aria-expanded", "false");
  await expect.element(glyph).toHaveFocus();
});

test("Escape still closes it once a control inside has focus", async () => {
  const screen = await tray({ pointerIn: true });
  const glyph = screen.getByRole("button", { name: "Site information" });
  await glyph.click();
  const inside = screen.getByRole("button", { name: "Inside" });
  inside.element().focus();
  await userEvent.keyboard("{Escape}");
  await expect.element(glyph).toHaveAttribute("aria-expanded", "false");
});

test("a press outside closes it", async () => {
  const screen = await tray({ pointerIn: true });
  const glyph = screen.getByRole("button", { name: "Site information" });
  await glyph.click();
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  await expect.element(glyph).toHaveAttribute("aria-expanded", "false");
});

test("the sections are told whether the panel is showing", async () => {
  const screen = await tray({ pointerIn: true });
  const told = () => screen.container.querySelector("output")?.textContent;
  expect(told()).toBe("hidden");
  await screen.getByRole("button", { name: "Site information" }).click();
  await expect.poll(told).toBe("showing");
});

test("a page that is not secure keeps the glyph in view, as a warning with its reason", async () => {
  const screen = await tray({ warning: "Connection is not encrypted" });
  const glyph = glyphOf(screen);
  expect(glyph.getAttribute("title")).toBe("Connection is not encrypted");
  expect(glyph.classList.contains("utilities-warning")).toBe(true);
  expect(getComputedStyle(glyph).opacity).toBe("1");
  // A warning is not something to reach with the pointer: it stays a tab stop.
  expect(glyph.hasAttribute("aria-hidden")).toBe(false);
  expect(glyph.tabIndex).toBe(0);
});

test("a page with nothing wrong waits for the pointer to bring the glyph in", async () => {
  const screen = await tray();
  const glyph = glyphOf(screen);
  expect(glyph.classList.contains("utilities-warning")).toBe(false);
  expect(getComputedStyle(glyph).opacity).toBe("0");
  // Painted away is also out of the tab order and out of the a11y tree: a
  // keyboard walk must not stop on an invisible button over the address pill.
  expect(glyph.getAttribute("tabindex")).toBe("-1");
  expect(glyph.getAttribute("aria-hidden")).toBe("true");
});

test("the pointer in the column brings it in, and it becomes a real control", async () => {
  const screen = await tray();
  const glyph = glyphOf(screen);
  expect(glyph.getAttribute("aria-hidden")).toBe("true");

  await screen.rerender({ pointerIn: true });
  await expect.poll(() => glyph.getAttribute("aria-hidden")).toBe(null);
  expect(glyph.tabIndex).toBe(0);
  await expect.element(screen.getByRole("button", { name: "Site information" })).toBeVisible();

  await screen.rerender({ pointerIn: false });
  await expect.poll(() => glyph.getAttribute("tabindex")).toBe("-1");
});
