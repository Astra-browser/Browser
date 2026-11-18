import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import * as sidebar from "$session/sidebar-mode.svelte";
import SidebarResizeHandle from "../components/SidebarResizeHandle.svelte";

const native = vi.hoisted(() => ({
  setWidth: vi.fn(async (_width: number | null, _travel: boolean, _revision: number | null) => {}),
  setHidden: vi.fn(async (_hidden: boolean) => {}),
}));

vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({
    sidebarSetWidth: native.setWidth,
    sidebarSetHidden: native.setHidden,
    settingSet: async () => ({ operation_id: null, accepted: true }),
    settingGet: async () => null,
    sidebarResize: async () => false,
    sidebarResizeGuide: async () => false,
  });
});

// A synthetic pointer is not a real active pointer, so the browser refuses
// capture; the component only needs the calls to be harmless.
vi.spyOn(HTMLElement.prototype, "setPointerCapture").mockImplementation(() => {});
vi.spyOn(HTMLElement.prototype, "releasePointerCapture").mockImplementation(() => {});
vi.spyOn(HTMLElement.prototype, "hasPointerCapture").mockReturnValue(true);

const at = (x: number) =>
  ({ bubbles: true, pointerId: 1, button: 0, clientX: x, clientY: 320 }) as const;

test("the column follows the pointer while it is held, then settles on release", async () => {
  sidebar.setMode("default");
  const start = sidebar.effectiveWidth();
  const screen = await render(SidebarResizeHandle, { width: start });
  const handle = screen.container.querySelector<HTMLElement>('[role="separator"]');
  expect(handle).not.toBeNull();
  if (!handle) return;

  handle.dispatchEvent(new PointerEvent("pointerdown", at(500)));
  expect(sidebar.sidebarDragWidth()).toBe(start);

  handle.dispatchEvent(new PointerEvent("pointermove", at(560)));
  expect(sidebar.sidebarDragWidth()).toBe(start + 60);
  await expect.poll(() => native.setWidth.mock.calls.at(-1)?.[0]).toBe(start + 60);
  expect(native.setWidth.mock.calls.at(-1)?.[1]).toBe(false);

  handle.dispatchEvent(new PointerEvent("pointermove", at(600)));
  expect(sidebar.sidebarDragWidth()).toBe(start + 100);

  handle.dispatchEvent(new PointerEvent("pointerup", at(600)));
  expect(sidebar.sidebarDragWidth()).toBeNull();
  expect(sidebar.expanded()).toBe(start + 100);
  await expect.poll(() => native.setWidth.mock.calls.at(-1)?.[1]).toBe(true);

  screen.unmount();
});

test("escape puts the column back where it started", async () => {
  sidebar.setMode("default");
  const before = sidebar.expanded();
  const screen = await render(SidebarResizeHandle, { width: before });
  const handle = screen.container.querySelector<HTMLElement>('[role="separator"]');
  expect(handle).not.toBeNull();
  if (!handle) return;

  handle.dispatchEvent(new PointerEvent("pointerdown", at(500)));
  handle.dispatchEvent(new PointerEvent("pointermove", at(580)));
  expect(sidebar.sidebarDragWidth()).toBe(before + 80);

  handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(sidebar.sidebarDragWidth()).toBeNull();
  expect(sidebar.expanded()).toBe(before);
  await expect.poll(() => native.setWidth.mock.calls.at(-1)?.[0]).toBe(before);

  screen.unmount();
});
