import { describe, expect, it } from "vitest";
import { tabFixture } from "$shared/testing/fixtures";
import { isRailTool, mediaTabs, railToolActive, sleepingTabs } from "../lib/rail-model";

describe("the rail's lists", () => {
  it("media is a tab playing sound or holding a capture", () => {
    const tabs = [
      tabFixture({ id: "audio", audio: { muted: false, can_mute: true } }),
      tabFixture({ id: "capture", capture: {} as never }),
      tabFixture({ id: "quiet" }),
    ];
    expect(mediaTabs(tabs, false).map((tab) => tab.id)).toEqual(["audio", "capture"]);
  });

  it("sleeping tabs are the ones native has put to sleep", () => {
    const tabs = [
      tabFixture({ id: "asleep", availability: { state: "sleeping" } }),
      tabFixture({ id: "waiting", availability: { state: "waiting_for_capacity", url: "" } }),
      tabFixture({ id: "awake" }),
    ];
    expect(sleepingTabs(tabs, false).map((tab) => tab.id)).toEqual(["asleep"]);
  });

  it("a private window reads neither list", () => {
    const tabs = [
      tabFixture({ id: "audio", audio: { muted: false, can_mute: true } }),
      tabFixture({ id: "asleep", availability: { state: "sleeping" } }),
    ];
    expect(mediaTabs(tabs, true)).toEqual([]);
    expect(sleepingTabs(tabs, true)).toEqual([]);
  });
});

describe("the rail's tools", () => {
  it("marks only the tool panels that open beside it", () => {
    expect(isRailTool("downloads")).toBe(true);
    expect(isRailTool("notes")).toBe(true);
    expect(isRailTool("media")).toBe(false);
    expect(isRailTool("spaces")).toBe(false);
  });

  it("lights the entry whose panel is open", () => {
    expect(railToolActive("downloads", "downloads")).toBe(true);
    expect(railToolActive("notes", "downloads")).toBe(false);
    expect(railToolActive("media", "media")).toBe(false);
  });
});
