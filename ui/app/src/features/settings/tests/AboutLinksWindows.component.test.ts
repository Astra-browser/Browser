import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import "$styles/global.css";
import AboutLinks from "../components/about/AboutLinks.svelte";

vi.mock("$shared/platform", () => ({ IS_MAC: false, IS_WINDOWS: true }));
vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({ browserOpenUrl: async () => ({ accepted: true, operation_id: null }) });
});

test("with no menu bar, About names its documentation Help", async () => {
  const screen = await render(AboutLinks);
  await expect.element(screen.getByText("Help", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Coming soon")).toBeVisible();
  expect(screen.getByRole("link", { name: "Help" }).query()).toBeNull();
  expect(screen.getByText("Docs").query()).toBeNull();
});
