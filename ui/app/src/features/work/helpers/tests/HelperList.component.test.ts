import "$styles/global.css";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import HelperList from "../components/HelperList.svelte";
import { newHelperEntry } from "../lib/helpers";

const budget = { maxSteps: 50, maxTokens: 32000, maxWallMs: 300000 };

test("the list names every helper, shows its pane anchor, and cancels one without touching the rest", async () => {
  const oncancel = vi.fn();
  const helpers = [
    {
      ...newHelperEntry("helper-1", "run-parent", "Fetch prices", budget),
      status: "running" as const,
    },
    {
      ...newHelperEntry("helper-2", "run-parent", "Read reviews", budget),
      status: "running" as const,
    },
    {
      ...newHelperEntry("helper-3", "run-parent", "Check stock", budget),
      status: "running" as const,
    },
  ];
  const screen = await render(HelperList, { helpers, oncancel });

  const rows = screen.container.querySelectorAll("[data-astra-helper-row]");
  expect(rows).toHaveLength(3);
  expect(
    screen.container.querySelector("[data-astra-helper-row='helper-1']")?.textContent,
  ).toContain("Fetch prices");
  // Each row anchors its helper's source pane.
  expect(
    screen.container
      .querySelector("[data-astra-helper-row='helper-2']")
      ?.getAttribute("data-astra-helper-pane"),
  ).toBe("helper-pane-helper-2");

  // Per-helper cancel: exactly one button per live helper, wired to its id.
  expect(screen.container.querySelectorAll("[data-astra-helper-cancel]")).toHaveLength(3);
  await screen.getByRole("button", { name: "Cancel helper Read reviews" }).click();
  expect(oncancel).toHaveBeenCalledTimes(1);
  expect(oncancel).toHaveBeenCalledWith("helper-2");
  await screen.unmount();
});

test("cancelled helpers keep their row but lose their cancel button", async () => {
  const oncancel = vi.fn();
  const helpers = [
    {
      ...newHelperEntry("helper-1", "run-parent", "Fetch prices", budget),
      status: "cancelled" as const,
      endReason: "user asked to stop",
    },
    {
      ...newHelperEntry("helper-2", "run-parent", "Read reviews", budget),
      status: "running" as const,
    },
  ];
  const screen = await render(HelperList, { helpers, oncancel });

  expect(screen.container.querySelectorAll("[data-astra-helper-row]")).toHaveLength(2);
  expect(screen.container.querySelector("[data-astra-helper-cancel='helper-1']")).toBeNull();
  expect(screen.container.querySelector("[data-astra-helper-cancel='helper-2']")).not.toBeNull();
  expect(screen.container.textContent).toContain("Cancelled — user asked to stop");
  await screen.unmount();
});

test("no helpers reads as empty, with no cancel buttons", async () => {
  const screen = await render(HelperList, { helpers: [] });
  await expect.element(screen.getByText("No helpers running.")).toBeVisible();
  expect(screen.container.querySelectorAll("[data-astra-helper-cancel]")).toHaveLength(0);
  await screen.unmount();
});
