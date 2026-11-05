/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Wiring tests: `@astra/bridge` reachable from the frame and behaving
// (invoke / listen / event_seq resync / MOCK mode) under the frame runner.

import { beforeEach, describe, expect, test } from "vitest";
import {
  COMMANDS,
  configureBridge,
  createHostDispatch,
  EVENTS,
  getBridge,
  invoke,
  listen,
  once,
  resetBridge,
} from "@astra/bridge";
import { __resetBridgeWiringForTests, ensureBridge, isStandalone } from "./bridge.js";

beforeEach(() => {
  resetBridge();
  __resetBridgeWiringForTests();
});

describe("bridge wiring", () => {
  test("covers the full surface (267 commands, 35 events)", () => {
    expect(COMMANDS).toHaveLength(267);
    expect(EVENTS).toHaveLength(35);
  });

  test("standalone is selected outside chrome (?astra-mock=1)", async () => {
    expect(isStandalone("?astra-mock=1")).toBe(true);
    const bridge = await ensureBridge("main", "?astra-mock=1");
    expect(bridge.mode).toBe("mock");
    expect(await invoke("ui_ready")).toBe(true);
  });

  test("resource:/about: documents take the mock path (P3-T17)", async () => {
    const holder = globalThis as Record<string, unknown>;
    const prev = holder.window;
    try {
      for (const protocol of ["http:", "https:", "file:", "resource:", "about:"]) {
        holder.window = { location: { protocol } };
        expect(isStandalone("")).toBe(true);
      }
      // The packaged app is a first-party chrome document (P3-T21): it boots
      // host mode by importing the Host API, never mock.
      holder.window = { location: { protocol: "chrome:" } };
      expect(isStandalone("")).toBe(false);
      // Unknown future schemes stay fail-closed: they try the host import.
      holder.window = { location: { protocol: "moz-nullprincipal:" } };
      expect(isStandalone("")).toBe(false);
      // The packaged page opened in a plain content tab boots mock instead
      // of throwing on the `resource://astra/host` import.
      holder.window = { location: { protocol: "resource:" } };
      const bridge = await ensureBridge("plain-tab", "");
      expect(bridge.mode).toBe("mock");
    } finally {
      if (prev === undefined) delete holder.window;
      else holder.window = prev;
    }
  });

  test("mock invoke answers shaped fixtures", async () => {
    await ensureBridge("main", "?astra-mock=1");
    expect(await invoke("ui_info")).toEqual({ version: "0.1.0-mock", os: "mock", arch: "mock" });
  });

  test("mock listen receives tab lifecycle events in order", async () => {
    await ensureBridge("main", "?astra-mock=1");
    const reasons: string[] = [];
    await listen<{ reason: string }>("tab-changed", (e) => {
      reasons.push(e.payload.reason);
    });
    await invoke("tabs_open");
    await invoke("tabs_navigate", { input: "https://example.invalid/" });
    expect(reasons).toEqual(["opened", "navigated"]);
    expect(getBridge().getLastSeq()).toBe(2);
  });

  test("once fires exactly once", async () => {
    await ensureBridge("main", "?astra-mock=1");
    let n = 0;
    await once("tab-changed", () => {
      n += 1;
    });
    await invoke("tabs_open");
    await invoke("tabs_open");
    expect(n).toBe(1);
  });

  test("event_seq gap fires onGap yet delivers newest truth", async () => {
    const bridge = configureBridge({ mode: "mock" });
    const gaps: unknown[] = [];
    bridge.onGap((g) => gaps.push(g));
    const payloads: unknown[] = [];
    bridge.listen("tab-changed", (e) => payloads.push(e.payload));
    expect(bridge.ingestEvent("tab-changed", { a: 1 }, "evt-0001", 1)).toBe(true);
    expect(bridge.ingestEvent("tab-changed", { a: 3 }, "evt-0003", 3)).toBe(false);
    expect(gaps).toEqual([{ expected: 2, got: 3, channel: "tab-changed" }]);
    expect(payloads).toHaveLength(2);
    expect(bridge.getGapCount()).toBe(1);
  });

  test("host dispatch routes to Host modules; unrouted fails fast", async () => {
    const seen: unknown[] = [];
    const fakeHost = {
      Tabs: {
        create: async (args: Record<string, unknown>) => {
          seen.push(args);
          return { astra_tab_id: "tab-1" };
        },
      },
      Navigation: {},
      Panes: {},
      Boot: {},
      Sidebar: {},
      WebExtensions: {},
      Settings: {},
      Accounts: {},
      Commands: {},
      Keymap: {},
      Work: {},
      Downloads: {},
      Media: {},
      Notes: {},
      Bookmarks: {},
      Time: {},
      HistoryCall: {},
      System: {},
      Resources: {},
      Search: {},
      PageSource: {},
      DialogPrompts: {},
      Permissions: {},
      BrowsingData: {},
      Blocker: {},
      Operations: {},
      addEventListener: () => () => {},
      eventSeq: () => 0,
    };
    const bridge = configureBridge({
      mode: "host",
      dispatch: createHostDispatch(fakeHost),
      newId: () => "req-1",
    });
    expect(await bridge.invoke("tabs_open", { background: true })).toEqual({
      astra_tab_id: "tab-1",
    });
    expect(seen[0]).toMatchObject({ background: true, request_id: "req-1" });
    await expect(bridge.invoke("profiles_get")).rejects.toMatchObject({
      code: "unknown_command",
    });
  });
});
