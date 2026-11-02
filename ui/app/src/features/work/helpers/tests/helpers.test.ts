import { expect, test } from "vitest";
import {
  budgetLabel,
  helperPaneId,
  isLiveHelper,
  isTerminalHelper,
  liveHelpers,
  newHelperEntry,
  statusLabel,
  usageLabel,
  type HelperEntry,
} from "../lib/helpers";

const budget = { maxSteps: 50, maxTokens: 32000, maxWallMs: 300000 };

function entry(id: string, status: HelperEntry["status"] = "pending"): HelperEntry {
  return { ...newHelperEntry(id, "run-parent", `goal ${id}`, budget), status };
}

test("source pane ids are deterministic per helper", () => {
  expect(helperPaneId("helper-1")).toBe("helper-pane-helper-1");
  expect(newHelperEntry("h1", "p", "goal", budget).paneId).toBe("helper-pane-h1");
});

test("liveness splits pending/running from terminal states", () => {
  expect(isLiveHelper("pending")).toBe(true);
  expect(isLiveHelper("running")).toBe(true);
  expect(isLiveHelper("succeeded")).toBe(false);
  expect(isLiveHelper("cancelled")).toBe(false);
  expect(isLiveHelper("failed")).toBe(false);
  expect(isLiveHelper("budget-exhausted")).toBe(false);
  expect(isTerminalHelper("cancelled")).toBe(true);
  expect(isTerminalHelper("running")).toBe(false);
});

test("three helpers in parallel each keep their own pane", () => {
  const helpers = [entry("helper-1"), entry("helper-2"), entry("helper-3")];
  expect(new Set(helpers.map((h) => h.paneId)).size).toBe(3);
  expect(liveHelpers(helpers)).toHaveLength(3);
});

test("a cancelled helper leaves the live set while the rest keep working", () => {
  const helpers = [entry("helper-1"), entry("helper-2"), entry("helper-3")];
  helpers[1]!.status = "cancelled";
  expect(liveHelpers(helpers).map((h) => h.id)).toEqual(["helper-1", "helper-3"]);
});

test("budget and usage read as one line each", () => {
  expect(budgetLabel(budget)).toBe("50 steps · 32k tokens · 5m");
  expect(budgetLabel({ maxSteps: 5, maxTokens: 800, maxWallMs: 45000 })).toBe(
    "5 steps · 800 tokens · 45s",
  );
  const helper = { ...entry("h1", "running"), stepsUsed: 3, tokensUsed: 1200 };
  expect(usageLabel(helper)).toBe("3/50 steps · 1.2k/32k tokens");
});

test("status lines name the end reason when one stopped", () => {
  expect(statusLabel(entry("h", "running"))).toBe("Working…");
  expect(statusLabel(entry("h", "succeeded"))).toBe("Done");
  expect(statusLabel({ ...entry("h", "cancelled"), endReason: "user asked to stop" })).toBe(
    "Cancelled — user asked to stop",
  );
  expect(statusLabel({ ...entry("h", "failed"), endReason: "page unreachable" })).toBe(
    "Failed — page unreachable",
  );
  expect(
    statusLabel({ ...entry("h", "budget-exhausted"), endReason: "Steps budget exceeded" }),
  ).toBe("Stopped — Steps budget exceeded");
});
