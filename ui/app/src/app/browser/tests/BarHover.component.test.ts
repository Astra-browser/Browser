import "$styles/global.css";
import { afterEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { emitNativeEvent } from "$shared/testing/native-events";
import { tabFixture, revision, spaceFixture } from "$shared/testing/fixtures";
import { tabs } from "$domain/tabs";
import { surface } from "$domain/surface";
import Shell from "../Shell.svelte";

vi.mock("../WorkWorkspace.svelte", async () => await import("./StageStub.svelte"));

vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({
    pagePermissionCardHost: async () => {},
    tabsBootstrap: async () => {},
    tabsActivate: async () => ({ accepted: true, operation_id: null }),
    sidebarSetHidden: async () => {},
    sidebarSetWidth: async () => {},
  });
});

afterEach(() => {
  surface.dispose();
  tabs.dispose();
});

function hover(hover: boolean) {
  window.dispatchEvent(
    new MessageEvent("message", { data: { ns: "astra-shell", kind: "bar-hover", hover } }),
  );
}

async function floatingBar() {
  await surface.init();
  await tabs.init();
  const tab = tabFixture({ url: "https://example.com/a" });
  emitNativeEvent("itemsChanged", {
    projection_revision: revision(40),
    profile: { id: "profile", name: "Personal", kind: "default" },
    spaces: [spaceFixture("space", "Home")],
    active_space_id: "space",
    nodes: [],
    tabs: [tab],
    active: tab.id,
    split_group: null,
  });
  const screen = await render(Shell);
  const bar = screen.container.querySelector<HTMLElement>(".stage-bar")!;
  await expect.poll(() => bar.getAttribute("data-hidden")).toBe("true");
  return { screen, bar };
}

// The shell's top-edge strip and the app's bar live in different documents,
// so crossing from one to the other reports leave and enter in an order that
// changes under load. The pointer is on the bar either way; the trail timer
// must not hide it under the controls (that made Back and Forward feel dead).
test("the floating bar stays down while the pointer crosses onto it", async () => {
  const { bar } = await floatingBar();

  hover(true);
  await expect.poll(() => bar.getAttribute("data-hidden")).toBe("false");

  // The app bar's enter may arrive before the shell strip's leave, or after.
  bar.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
  hover(false);
  await new Promise((done) => setTimeout(done, 330));
  expect(bar.getAttribute("data-hidden")).toBe("false");
  expect(window.getComputedStyle(bar).pointerEvents).not.toBe("none");

  // Leaving the bar with the strip no longer held hides it after the trail.
  bar.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false }));
  await expect.poll(() => bar.getAttribute("data-hidden")).toBe("true");
});

test("the floating bar stays down when the pointer moves back to the strip", async () => {
  const { bar } = await floatingBar();

  hover(true);
  await expect.poll(() => bar.getAttribute("data-hidden")).toBe("false");

  // Enter the bar, then leave it upward onto the shell strip. The bar's leave
  // may be handled after the strip's enter; the strip still owns the pointer.
  bar.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
  hover(true);
  bar.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false }));
  await new Promise((done) => setTimeout(done, 330));
  expect(bar.getAttribute("data-hidden")).toBe("false");

  hover(false);
  await expect.poll(() => bar.getAttribute("data-hidden")).toBe("true");
});
