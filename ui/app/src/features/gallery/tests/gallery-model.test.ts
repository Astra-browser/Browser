import { describe, expect, it } from "vitest";
import {
  countLabel,
  folderLabel,
  openLabel,
  relativeDay,
  relativeUpdate,
} from "../lib/gallery-model";

const NOON = new Date(2026, 10, 20, 12, 0, 0).getTime();
const DAY = 86_400_000;

describe("gallery dates", () => {
  it("names today and yesterday rather than a count", () => {
    expect(relativeDay(NOON, NOON)).toBe("today");
    expect(relativeDay(NOON - DAY, NOON)).toBe("yesterday");
  });

  it("counts the days inside the last week", () => {
    expect(relativeDay(NOON - 3 * DAY, NOON)).toBe("3 days ago");
  });

  it("uses a date further back", () => {
    const old = new Date(2025, 0, 2).getTime();
    expect(relativeDay(old, NOON)).toMatch(/2025/u);
  });

  it("does not claim an unknown timestamp", () => {
    expect(relativeDay(0, NOON)).toBe("");
  });

  it("says a fresh scan just happened", () => {
    expect(relativeUpdate(NOON - 2000, NOON)).toBe("just now");
    expect(relativeUpdate(NOON - 120_000, NOON)).toMatch(/2 minutes/u);
  });
});

describe("gallery labels", () => {
  it("uses the counted plural only for more than one", () => {
    expect(countLabel(1)).toBe("1 picture");
    expect(countLabel(12)).toBe("12 pictures");
  });

  it("names the system opener when it is known", () => {
    expect(openLabel("Photos")).toBe("Open in Photos");
    expect(openLabel("")).toBe("Open");
  });

  it("resolves a folder label from the configured rows", () => {
    const rows = [{ path: "/home/me/Pictures", label: "Pictures" }];
    expect(folderLabel("/home/me/Pictures", rows)).toBe("Pictures");
    expect(folderLabel("/home/me/Other", rows)).toBe("Other");
  });
});
