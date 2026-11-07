import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import "$styles/global.css";
import type { SpaceView } from "$shared/ipc/bindings";
import SpaceEditor from "../components/SpaceEditor.svelte";

vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({
    settingGet: async () => null,
    tabsBootstrap: async () => {},
    keymapEntries: async () => [],
  });
});

const space: SpaceView = {
  id: "studio",
  name: "Studio",
  profile_id: "default",
  icon: { kind: "symbol", index: 1 },
  color: 2,
  theme: null,
  tabs: 3,
  previews: [],
};

// The confirmation replaces the action that asked for it, so the keyboard has
// to land on the way out of it and come back when it is taken. Without that,
// pressing Enter on Delete drops focus to the top of the document.
test("Delete asks in place, keeps the keyboard in the confirmation and gives it back", async () => {
  const screen = await render(SpaceEditor, {
    space,
    deletable: true,
    onclose: () => {},
  });
  await screen.getByRole("button", { name: "Delete…" }).click();
  const cancel = screen.getByRole("button", { name: "Cancel" });
  await expect.element(cancel).toHaveFocus();
  expect(screen.getByText("Its 3 tabs will close.").elements()).toHaveLength(1);

  await cancel.click();
  await expect.element(screen.getByRole("button", { name: "Delete…" })).toHaveFocus();
  expect(screen.getByText("Its 3 tabs will close.").elements()).toHaveLength(0);
});

test("Escape steps out of the confirmation before it leaves the editor", async () => {
  const screen = await render(SpaceEditor, {
    space,
    deletable: true,
    onclose: () => {},
  });
  await screen.getByRole("button", { name: "Delete…" }).click();
  await expect.element(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  await vi.waitFor(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect.element(screen.getByRole("button", { name: "Delete…" })).toBeVisible();
  });
  expect(screen.getByRole("button", { name: "Delete…" })).toHaveFocus();
});
