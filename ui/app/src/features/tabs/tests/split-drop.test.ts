import { expect, test } from "vitest";
import { splitDropTarget } from "../lib/split-drop";

/** A fake row with a known rectangle; the helper reads only these fields. */
function row(id: string, left = 0, top = 0, width = 240, height = 28): Element {
  const rect = {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  } as DOMRect;
  const element = {
    dataset: { astraTabId: id },
    getBoundingClientRect: () => rect,
  };
  return {
    ...element,
    closest: () => element,
  } as unknown as Element;
}

const options = (over: Element | null, x: number, y: number, enabled = true) => ({
  dragged: "a",
  over,
  x,
  y,
  enabled,
  canJoin: () => true,
});

test("the middle of another tab is a split target", () => {
  expect(splitDropTarget(options(row("b"), 120, 14))).toBe("b");
});

test("the top edge of a row stays a reorder zone", () => {
  expect(splitDropTarget(options(row("b"), 120, 2))).toBeNull();
});

test("the bottom edge of a row stays a reorder zone", () => {
  expect(splitDropTarget(options(row("b"), 120, 27))).toBeNull();
});

test("a row's own tab, a disabled setting and a refused tab never split", () => {
  expect(splitDropTarget(options(row("a"), 120, 14))).toBeNull();
  expect(splitDropTarget(options(row("b"), 120, 14, false))).toBeNull();
  expect(
    splitDropTarget({
      ...options(row("b"), 120, 14),
      canJoin: () => false,
    }),
  ).toBeNull();
});

test("a narrow rail row keeps a central split band", () => {
  expect(splitDropTarget(options(row("b", 0, 0, 28, 28), 14, 14))).toBe("b");
  expect(splitDropTarget(options(row("b", 0, 0, 28, 28), 2, 14))).toBeNull();
});
