import "$styles/global.css";
import { afterEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { userEvent } from "vitest/browser";
import { favicons } from "$domain/favicons";
import { preferences } from "$domain/preferences";
import { surface } from "$domain/surface";
import { tabs } from "$domain/tabs";
import Shell from "../Shell.svelte";
import { paint } from "./look-bench";

vi.mock("$shared/platform", () => ({ IS_MAC: false, IS_WINDOWS: true }));
vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({
    pagePermissionCardHost: async () => {},
    tabsBootstrap: async () => {},
    sidebarSetHidden: async () => {},
    sidebarPeek: async () => {},
    sidebarSetWidth: async () => {},
    sidebarResize: async () => false,
    sidebarResizeGuide: async () => true,
  });
});

afterEach(() => {
  favicons.dispose();
  surface.dispose();
  tabs.dispose();
  preferences.dispose();
});

// On Windows the page bar is the horizontal top panel and carries the window's
// own minimise/maximise/close at its trailing end. Those three come out when
// the hand is on the panel and are out of the way (and out of the pointer's
// way) at rest. Nothing floats over the page. The address itself stays in the
// column's head, so the bar never owns it in the full-column shape.
test("the window's controls belong to the page bar, out until it is hovered", async () => {
  await paint();
  const screen = await render(Shell);

  const bar = screen.container.querySelector<HTMLElement>("[data-content-bar]")!;
  await expect.poll(() => bar.querySelector(".window-controls-inline")).not.toBeNull();
  const controls = bar.querySelector<HTMLElement>(".window-controls-inline")!;
  const buttons = [...controls.querySelectorAll<HTMLButtonElement>("button")];
  expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
    "Minimize",
    "Maximize",
    "Close",
  ]);

  // The address stays in the column's head; the bar only holds the controls.
  expect(bar.querySelector(".address-field input, input[data-astra-address]")).toBeNull();
  expect(screen.container.querySelector(".sidebar-top-field [data-astra-address]")).not.toBeNull();

  // At rest the trio is invisible and cannot eat a hover from the field.
  expect(getComputedStyle(controls).opacity).toBe("0");
  expect(getComputedStyle(controls).pointerEvents).toBe("none");

  await userEvent.hover(bar);
  await expect.poll(() => getComputedStyle(controls).opacity).toBe("1");
  expect(getComputedStyle(controls).pointerEvents).toBe("auto");

  // The old floating capsule is gone on Windows.
  expect(document.querySelector("body > .window-controls")).toBeNull();

  // Focus brings them out too: the keyboard reaches the panel the same way.
  buttons[0]!.focus();
  await expect.poll(() => getComputedStyle(controls).opacity).toBe("1");

  await screen.unmount();
});
