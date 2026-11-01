import { afterEach, describe, expect, it, vi } from "vitest";
import { configureBridge, resetBridge, type Bridge } from "@astra/bridge";
import { TabsBridgeStore, fallbackLetter, normalizeTab } from "../lib/tabs-bridge-store";

function setup(): { bridge: Bridge; store: TabsBridgeStore } {
  const bridge = configureBridge({ mode: "mock" });
  return { bridge, store: new TabsBridgeStore(bridge) };
}

afterEach(() => {
  resetBridge();
});

describe("tab-changed events", () => {
  it("bootstraps and applies opened, navigated, activated and closed payloads", async () => {
    const { bridge, store } = setup();
    const mock = bridge.mockHost()!;
    await store.bootstrap();

    mock.emitEvent("tab-changed", {
      astra_tab_id: "tab-1",
      title: "One",
      url: "https://one.example/",
      reason: "opened",
    });
    mock.emitEvent("tab-changed", {
      astra_tab_id: "tab-2",
      title: "Two",
      url: "https://two.example/",
      reason: "opened",
    });
    expect(store.snapshot().tabs.map((tab) => tab.id)).toEqual(["tab-1", "tab-2"]);

    mock.emitEvent("tab-changed", {
      astra_tab_id: "tab-1",
      title: "One!",
      url: "https://one.example/next",
      reason: "navigated",
    });
    expect(store.tab("tab-1")?.title).toBe("One!");
    expect(store.tab("tab-1")?.url).toBe("https://one.example/next");

    mock.emitEvent("tab-changed", { astra_tab_id: "tab-2", selected: true, reason: "activated" });
    expect(store.snapshot().activeId).toBe("tab-2");
    expect(store.tab("tab-1")?.selected).toBe(false);

    mock.emitEvent("tab-changed", { astra_tab_id: "tab-1", reason: "closed" });
    expect(store.snapshot().tabs.map((tab) => tab.id)).toEqual(["tab-2"]);
    store.dispose();
  });

  it("ignores payloads without an id and notifies subscribers on change", async () => {
    const { store } = setup();
    await store.bootstrap();
    const fn = vi.fn();
    store.subscribe(fn);
    expect(store.applyEvent({ nope: true })).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    expect(store.applyEvent({ astra_tab_id: "tab-9", title: "Nine", reason: "opened" })).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    // An identical re-delivery moves nothing and notifies nobody.
    expect(store.applyEvent({ astra_tab_id: "tab-9", title: "Nine", reason: "opened" })).toBe(
      false,
    );
    expect(fn).toHaveBeenCalledTimes(1);
    store.dispose();
  });
});

describe("drag-reorder persistence", () => {
  it("moves the tab before its target and persists via tabs_set_essential", async () => {
    const { bridge, store } = setup();
    const mock = bridge.mockHost()!;
    const calls: Record<string, unknown>[] = [];
    mock.respond("tabs_set_essential", async (args) => {
      calls.push(args);
      return { admitted: true };
    });
    store.seed([
      { astra_tab_id: "a", title: "A" },
      { astra_tab_id: "b", title: "B" },
      { astra_tab_id: "c", title: "C" },
    ]);
    await store.move("a", "c");
    expect(store.snapshot().tabs.map((tab) => tab.id)).toEqual(["b", "a", "c"]);
    expect(calls).toEqual([{ id: "a", essential: false, before: "c" }]);
  });

  it("drops at the end on null and keeps pinned runs apart", async () => {
    const { bridge, store } = setup();
    const mock = bridge.mockHost()!;
    mock.respond("tabs_set_essential", async () => ({ admitted: true }));
    store.seed([
      { astra_tab_id: "p", title: "P", pinned: true },
      { astra_tab_id: "a", title: "A" },
      { astra_tab_id: "b", title: "B" },
    ]);
    await store.move("a", null);
    expect(store.snapshot().tabs.map((tab) => tab.id)).toEqual(["p", "b", "a"]);
    await store.move("p", null);
    expect(store.snapshot().tabs.map((tab) => tab.id)).toEqual(["p", "b", "a"]);
    expect(store.tab("p")?.pinned).toBe(true);
  });

  it("ignores a move for an unknown tab", async () => {
    const { store } = setup();
    store.seed([{ astra_tab_id: "a", title: "A" }]);
    await store.move("missing", null);
    expect(store.snapshot().tabs.map((tab) => tab.id)).toEqual(["a"]);
  });
});

describe("pinned section", () => {
  it("splits pinned from open and toggles through the bridge", async () => {
    const { bridge, store } = setup();
    const mock = bridge.mockHost()!;
    const calls: Record<string, unknown>[] = [];
    mock.respond("tabs_set_essential", async (args) => {
      calls.push(args);
      return { admitted: true };
    });
    store.seed([
      { astra_tab_id: "a", title: "A", pinned: true },
      { astra_tab_id: "b", title: "B" },
    ]);
    expect(store.pinnedTabs.map((tab) => tab.id)).toEqual(["a"]);
    expect(store.openTabs.map((tab) => tab.id)).toEqual(["b"]);

    await store.togglePin("b");
    expect(calls).toEqual([{ id: "b", essential: true, before: null }]);
    expect(store.pinnedTabs.map((tab) => tab.id)).toEqual(["a", "b"]);

    await store.togglePin("a");
    expect(store.pinnedTabs.map((tab) => tab.id)).toEqual(["b"]);
    expect(store.openTabs.map((tab) => tab.id)).toEqual(["a"]);
  });

  it("keeps the local section when native refuses", async () => {
    const { bridge, store } = setup();
    bridge.mockHost()!.respond("tabs_set_essential", async () => ({ admitted: false }));
    store.seed([{ astra_tab_id: "b", title: "B" }]);
    await store.togglePin("b");
    expect(store.pinnedTabs).toEqual([]);
    expect(store.openTabs.map((tab) => tab.id)).toEqual(["b"]);
  });
});

describe("folders", () => {
  it("creates, renames, assigns, collapses and deletes with spill", () => {
    const { store } = setup();
    store.seed([
      { astra_tab_id: "a", title: "A" },
      { astra_tab_id: "b", title: "B" },
      { astra_tab_id: "p", title: "P", pinned: true },
    ]);
    const folder = store.createFolder("Work");
    store.assignToFolder("a", folder.id);
    store.assignToFolder("b", folder.id);
    store.assignToFolder("p", folder.id);

    const units = store.visibleUnits();
    expect(units.map((unit) => unit.kind)).toEqual(["tab", "folder"]);
    const group = units[1];
    expect(group?.kind).toBe("folder");
    expect(group?.kind === "folder" ? group.children.map((child) => child.id) : []).toEqual([
      "a",
      "b",
    ]);
    // A pinned tab never renders inside a folder.
    expect(store.pinnedTabs.map((tab) => tab.id)).toEqual(["p"]);

    store.renameFolder(folder.id, "Play");
    expect(store.visibleUnits()[1]).toMatchObject({ kind: "folder", folder: { name: "Play" } });

    store.toggleFolder(folder.id);
    expect(store.isCollapsed(folder.id)).toBe(true);
    expect(store.visibleUnits()[1]).toMatchObject({ kind: "folder", expanded: false });

    // The folded folder still shows while one of its own rows is selected.
    store.applyEvent({ astra_tab_id: "a", title: "A", selected: true, reason: "activated" });
    expect(store.visibleUnits()[1]).toMatchObject({ kind: "folder", expanded: true });

    store.deleteFolder(folder.id);
    expect(store.visibleUnits().map((unit) => unit.kind)).toEqual(["tab", "tab", "tab"]);
    expect(store.folderOf("a")).toBeNull();
  });

  it("ignores assignments to unknown folders and unassigns to root", () => {
    const { store } = setup();
    store.seed([{ astra_tab_id: "a", title: "A" }]);
    store.assignToFolder("a", "missing");
    expect(store.folderOf("a")).toBeNull();
    const folder = store.createFolder("F");
    store.assignToFolder("a", folder.id);
    expect(store.folderOf("a")?.id).toBe(folder.id);
    store.assignToFolder("a", null);
    expect(store.folderOf("a")).toBeNull();
  });
});

describe("context menus", () => {
  it("asks for the native popup with the tab's context", async () => {
    const { bridge, store } = setup();
    const mock = bridge.mockHost()!;
    const calls: Record<string, unknown>[] = [];
    mock.respond("tab_menu_popup", async (args) => {
      calls.push(args);
      return true;
    });
    store.seed([
      { astra_tab_id: "a", title: "A", url: "https://a.example/", selected: true },
      { astra_tab_id: "b", title: "B", url: "https://b.example/" },
      { astra_tab_id: "c", title: "C", url: null },
    ]);
    const action = await store.openMenu("b", 10, 20);
    expect(action).toMatchObject({
      id: "b",
      x: 10,
      y: 20,
      context: {
        page: true,
        can_split: true,
        essential: false,
        others: true,
        below: true,
        muted: false,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: "b", x: 10, y: 20 });

    const last = await store.openMenu("c", 1, 2);
    expect(last.context.page).toBe(false);
    expect(last.context.below).toBe(false);
  });

  it("closes and mutes through the bridge", async () => {
    const { bridge, store } = setup();
    const mock = bridge.mockHost()!;
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    mock.respond("tabs_close", async (args) => {
      calls.push({ cmd: "tabs_close", args });
      return { admitted: true };
    });
    mock.respond("tab_set_muted", async (args) => {
      calls.push({ cmd: "tab_set_muted", args });
      return { admitted: true };
    });
    store.seed([{ astra_tab_id: "a", title: "A", audio: { muted: false } }]);
    await store.closeTab("a");
    await store.toggleMute("a");
    expect(calls).toEqual([
      { cmd: "tabs_close", args: { id: "a" } },
      { cmd: "tab_set_muted", args: { id: "a", muted: true } },
    ]);
  });
});

describe("sleeping and audio badges", () => {
  it("reads sleeping from either the Host or the app shape", () => {
    expect(normalizeTab({ astra_tab_id: "h", discarded: true })?.sleeping).toBe(true);
    expect(normalizeTab({ id: "a", availability: { state: "sleeping" } })?.sleeping).toBe(true);
    expect(
      normalizeTab({ id: "w", availability: { state: "waiting_for_capacity" } })?.sleeping,
    ).toBe(false);
    expect(normalizeTab({ id: "n", title: "N" })?.sleeping).toBe(false);
    expect(normalizeTab({})).toBeNull();
  });

  it("derives mute and audibility without moving the title", () => {
    const playing = normalizeTab({ id: "p", audio: { muted: false, can_mute: true } })!;
    expect(playing.audible).toBe(true);
    expect(playing.muted).toBe(false);
    const muted = normalizeTab({ id: "m", muted: true })!;
    expect(muted.audible).toBe(true);
    expect(muted.muted).toBe(true);
    const quiet = normalizeTab({ id: "q", title: "Q" })!;
    expect(quiet.audible).toBe(false);
  });
});

describe("favicons", () => {
  it("keeps icon urls, falls back to a letter, and probes missing origins", async () => {
    const { bridge, store } = setup();
    const mock = bridge.mockHost()!;
    const calls: Record<string, unknown>[] = [];
    mock.respond("favicon_probe", async (args) => {
      calls.push(args);
      return true;
    });
    store.seed([
      {
        astra_tab_id: "a",
        title: " Ahoy",
        url: "https://a.example/x",
        icon: "https://a.example/i.png",
      },
      { astra_tab_id: "b", title: "", url: "https://b.example/" },
      { astra_tab_id: "c", title: "3com", url: "https://c.example/" },
      { astra_tab_id: "d", title: "D", url: "about:blank" },
    ]);
    expect(store.tab("a")?.favIconUrl).toBe("https://a.example/i.png");
    expect(fallbackLetter(store.tab("a")!)).toBe("A");
    expect(fallbackLetter(store.tab("b")!)).toBe("H");
    expect(fallbackLetter(store.tab("c")!)).toBe("3");
    await store.ensureFavicons();
    expect(calls).toHaveLength(1);
    expect(new Set(calls[0]!["origins"] as string[])).toEqual(
      new Set(["https://b.example", "https://c.example"]),
    );
  });

  it("skips the probe when there is nothing to learn", async () => {
    const { bridge, store } = setup();
    const spy = vi.fn(async () => true);
    bridge.mockHost()!.respond("favicon_probe", spy);
    store.seed([
      { astra_tab_id: "a", title: "A", url: "https://a.example/", icon: "https://a.example/i.png" },
    ]);
    await store.ensureFavicons();
    expect(spy).not.toHaveBeenCalled();
  });
});
