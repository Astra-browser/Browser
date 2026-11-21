import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { emitNativeEvent } from "$shared/testing/native-events";
import { revision, spaceFixture, tabFixture } from "$shared/testing/fixtures";
import { tabs } from "$domain/tabs";
import { SplitPicker } from "$features/split";
import * as picker from "$session/split-picker.svelte";

const native = vi.hoisted(() => ({
  splitOpen: vi.fn(async () => ({ split: true })),
  splitOpenUrl: vi.fn(async () => ({ split: true })),
  splitUnsplit: vi.fn(async () => ({ unsplit: true })),
}));

vi.mock("$shared/ipc/surfaces", async (original) => ({
  ...(await original<typeof import("$shared/ipc/surfaces")>()),
  splitOpen: native.splitOpen,
  splitOpenUrl: native.splitOpenUrl,
  splitUnsplit: native.splitUnsplit,
}));

let clock = 0;
const next = () => revision(++clock);

const snapshot = (
  list: ReturnType<typeof tabFixture>[],
  splitGroup: { members: string[] } | null = null,
  splitGroups: Array<{ members: string[] }> | null = null,
) => ({
  projection_revision: next(),
  profile: { id: "profile", name: "Personal", kind: "default" as const },
  spaces: [spaceFixture("space", "Home")],
  active_space_id: "space",
  nodes: [],
  tabs: list.map((tab) => ({ ...tab, projection_revision: next() })),
  active: list[0]!.id,
  split_group: splitGroup,
  split_groups: splitGroups,
});

beforeEach(async () => {
  vi.clearAllMocks();
  await tabs.init();
  emitNativeEvent(
    "itemsChanged",
    snapshot([
      tabFixture({ id: "a", title: "Astra docs" }),
      tabFixture({ id: "b", title: "Design" }),
      tabFixture({ id: "c", title: "Notes" }),
    ]),
  );
  picker.close();
});

afterEach(() => {
  picker.close();
  tabs.dispose();
});

test("the picker pairs the tab that was chosen with the one that was right-clicked", async () => {
  render(SplitPicker);
  picker.open("a");
  await expect.poll(() => document.querySelector("dialog")?.open).toBe(true);
  const row = [...document.querySelectorAll<HTMLButtonElement>(".picker-row")].find((entry) =>
    entry.textContent?.includes("Design"),
  )!;
  row.click();
  await expect.poll(() => native.splitOpen.mock.calls).toEqual([["a", "b"]]);
  expect(picker.isOpen()).toBe(false);
});

test("New tab opens a blank pane beside the source, not beside whatever is selected", async () => {
  render(SplitPicker);
  picker.open("b");
  await expect.poll(() => document.querySelector("dialog")?.open).toBe(true);
  document.querySelector<HTMLButtonElement>(".picker-new")!.click();
  await expect.poll(() => native.splitOpenUrl.mock.calls).toEqual([["about:blank", "right", "b"]]);
});

test("a split at the pane cap says so and offers to separate it", async () => {
  const members = ["a", "b", "c"];
  emitNativeEvent(
    "itemsChanged",
    snapshot(
      [
        tabFixture({ id: "a", title: "Astra docs" }),
        tabFixture({ id: "b", title: "Design" }),
        tabFixture({ id: "c", title: "Notes" }),
      ],
      { members },
      [{ members }],
    ),
  );
  render(SplitPicker);
  picker.open("a");
  await expect
    .poll(() => document.querySelector("dialog")?.textContent)
    .toContain("This split view is full");
  const end = [...document.querySelectorAll<HTMLButtonElement>("button")].find((entry) =>
    entry.textContent?.includes("Separate this split"),
  )!;
  end.click();
  await expect.poll(() => native.splitUnsplit.mock.calls).toEqual([["a"]]);
});
