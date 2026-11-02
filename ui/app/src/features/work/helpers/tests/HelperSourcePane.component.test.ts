import "$styles/global.css";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import HelperSourcePane from "../components/HelperSourcePane.svelte";
import { newHelperEntry } from "../lib/helpers";

const budget = { maxSteps: 50, maxTokens: 32000, maxWallMs: 300000 };

test("the source pane shows the helper's live page anchor and cancels from the pane", async () => {
  const oncancel = vi.fn();
  const helper = {
    ...newHelperEntry("helper-1", "run-parent", "Fetch prices", budget),
    status: "running" as const,
    containerId: "firefox-container-7",
    stepsUsed: 3,
    tokensUsed: 1200,
  };
  const screen = await render(HelperSourcePane, { helper, oncancel });

  const pane = screen.container.querySelector<HTMLElement>("[data-astra-helper-pane]")!;
  expect(pane.dataset.astraHelperPane).toBe("helper-pane-helper-1");
  expect(pane.dataset.astraHelperStatus).toBe("running");
  expect(pane.dataset.astraHelperContainer).toBe("firefox-container-7");
  expect(pane.textContent).toContain("Fetch prices");
  expect(pane.textContent).toContain("3/50 steps");

  // The live page mounts in the hole the shell fills with the `<browser>` slot.
  const hole = screen.container.querySelector("[data-astra-helper-hole='helper-pane-helper-1']");
  expect(hole).not.toBeNull();

  await screen.getByRole("button", { name: "Cancel helper Fetch prices" }).click();
  expect(oncancel).toHaveBeenCalledTimes(1);
  expect(oncancel).toHaveBeenCalledWith("helper-1");
  await screen.unmount();
});

test("a stopped helper keeps its pane record but offers no cancel", async () => {
  const oncancel = vi.fn();
  const helper = {
    ...newHelperEntry("helper-1", "run-parent", "Fetch prices", budget),
    status: "cancelled" as const,
    endReason: "user asked to stop",
    containerId: "firefox-container-7",
  };
  const screen = await render(HelperSourcePane, { helper, oncancel });

  expect(screen.container.querySelector("[data-astra-helper-cancel]")).toBeNull();
  expect(screen.container.textContent).toContain("Cancelled — user asked to stop");
  // The pane anchor stays for audit: the record outlives the live tab.
  expect(
    screen.container.querySelector("[data-astra-helper-hole='helper-pane-helper-1']"),
  ).not.toBeNull();
  await screen.unmount();
});
