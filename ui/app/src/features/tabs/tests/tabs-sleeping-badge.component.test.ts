import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { userEvent } from "vitest/browser";
import { tabFixture } from "$shared/testing/fixtures";
import TabsSleepingBadge from "../components/TabsSleepingBadge.svelte";

test("a live tab shows no badge", async () => {
  const screen = await render(TabsSleepingBadge, {
    tab: tabFixture(),
    onWake: vi.fn(),
  });
  expect(screen.container.querySelector("[data-astra-sleeping-badge]")).toBeNull();
});

test("a sleeping tab shows its badge without moving the row", async () => {
  const tab = tabFixture({ availability: { state: "sleeping" } });
  const onWake = vi.fn();
  const screen = await render(TabsSleepingBadge, { tab, onWake });
  const badge = screen.container.querySelector<HTMLElement>("[data-astra-sleeping-badge]")!;
  expect(badge.textContent).toContain("Sleeping");
  expect(badge.getAttribute("aria-label")).toContain("wake");
});

test("the badge wakes its own tab and selects nothing else", async () => {
  const tab = tabFixture({ title: "Docs", availability: { state: "sleeping" } });
  const onWake = vi.fn();
  const screen = await render(TabsSleepingBadge, { tab, onWake });
  await screen.getByRole("button", { name: /Sleeping tab Docs/ }).click();
  expect(onWake).toHaveBeenCalledExactlyOnceWith(tab.id);
});

test("capacity states are not sleeping badges", async () => {
  for (const state of ["waiting_for_capacity", "blocked_by_capacity"] as const) {
    const screen = await render(TabsSleepingBadge, {
      tab: tabFixture({ availability: { state, url: "https://x.example/" } }),
      onWake: vi.fn(),
    });
    expect(screen.container.querySelector("[data-astra-sleeping-badge]")).toBeNull();
    screen.unmount();
  }
});

test("a middle-click on the badge does not wake the tab", async () => {
  const tab = tabFixture({ availability: { state: "sleeping" } });
  const onWake = vi.fn();
  const screen = await render(TabsSleepingBadge, { tab, onWake });
  await userEvent.click(screen.getByRole("button", { name: /Sleeping tab/ }), {
    button: "middle",
  });
  expect(onWake).not.toHaveBeenCalled();
});
