/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Bridge contract tests (P2-T08): invoke / listen / event_seq resync / MOCK.

import { describe, expect, test } from "bun:test";
import { Bridge, BridgeError } from "./bridge.js";
import { MockHost, mockCommandNames, mockEventChannels } from "./mock-host.js";
import { createHostDispatch } from "./host-transport.js";
import { COMMANDS, EVENTS, PROTOCOL_VERSION, parseEnvelope } from "./proto.js";
import type { Envelope } from "./proto.js";

function mockBridge() {
  let n = 0;
  return new Bridge({ mode: "mock", newId: () => `req-test-${++n}` });
}

describe("surface coverage", () => {
  test("covers all 267 commands and 35 events", () => {
    expect(mockCommandNames()).toHaveLength(267);
    expect(mockEventChannels()).toHaveLength(35);
    expect(COMMANDS).toHaveLength(267);
    expect(EVENTS).toHaveLength(35);
  });

  test("mock answers every command without hanging", async () => {
    const b = mockBridge();
    for (const cmd of COMMANDS) {
      await expect(b.invoke(cmd, {})).resolves.toBeDefined();
    }
  }, 30_000);
});

describe("invoke", () => {
  test("resolves shaped fixtures", async () => {
    const b = mockBridge();
    expect(await b.invoke("ui_info")).toEqual({ version: "0.1.0-mock", os: "mock", arch: "mock" });
    expect(await b.invoke("ui_ready")).toBe(true);
    expect(await b.invoke("tabs_open")).toEqual({ admitted: true });
  });

  test("tab lifecycle round-trips through events", async () => {
    const b = mockBridge();
    const seen: string[] = [];
    b.listen("tab-changed", (e) => seen.push((e.payload as { reason: string }).reason));
    await b.invoke("tabs_open");
    await b.invoke("tabs_navigate", { input: "https://example.invalid/" });
    expect(seen).toEqual(["opened", "navigated"]);
  });

  test("mock overrides win over defaults", async () => {
    const b = mockBridge();
    b.mockHost()!.respond("setting_get", () => "mock-value");
    expect(await b.invoke("setting_get", { key: "k" })).toBe("mock-value");
  });

  test("host errors surface as BridgeError", async () => {
    const failing = new Bridge({
      mode: "host",
      dispatch: async (req) => ({
        v: PROTOCOL_VERSION,
        id: req.id,
        kind: "res",
        name: req.name,
        payload: {},
        error: { code: "denied", message: "no" },
      }),
    });
    await expect(failing.invoke("tabs_open")).rejects.toMatchObject({ code: "denied" });
  });

  test("id mismatch fails fast", async () => {
    const bad = new Bridge({
      mode: "host",
      dispatch: async (req) => ({ ...req, kind: "res", payload: {} }) as Envelope,
    });
    // Same id passes through; forge a mismatch instead.
    const mismatch = new Bridge({
      mode: "host",
      newId: () => "req-a",
      dispatch: async () => ({
        v: PROTOCOL_VERSION, id: "req-b", kind: "res", name: "x", payload: {},
      }),
    });
    await expect(mismatch.invoke("x")).rejects.toBeInstanceOf(BridgeError);
    expect(bad).toBeDefined();
  });

  test("unknown protocol version fails fast", () => {
    expect(() => parseEnvelope({ v: 999, id: "a", kind: "req", name: "x" })).toThrow();
  });
});

describe("listen", () => {
  test("receives mock events with seq", async () => {
    const b = mockBridge();
    const got: Array<{ seq?: number; payload: unknown }> = [];
    b.listen("tab-changed", (e) => got.push({ seq: e.seq, payload: e.payload }));
    await b.invoke("tabs_open");
    expect(got).toHaveLength(1);
    expect(got[0]!.seq).toBe(1);
    expect(b.getLastSeq()).toBe(1);
  });

  test("unlisten stops delivery", async () => {
    const b = mockBridge();
    let n = 0;
    const unlisten = b.listen("tab-changed", () => (n += 1));
    unlisten();
    await b.invoke("tabs_open");
    expect(n).toBe(0);
  });

  test("once fires exactly once", async () => {
    const b = mockBridge();
    let n = 0;
    b.once("tab-changed", () => (n += 1));
    await b.invoke("tabs_open");
    await b.invoke("tabs_open");
    expect(n).toBe(1);
  });

  test("throwing listener does not break the pump", async () => {
    const b = mockBridge();
    let second = 0;
    b.listen("tab-changed", () => {
      throw new Error("ui bug");
    });
    b.listen("tab-changed", () => (second += 1));
    await b.invoke("tabs_open");
    expect(second).toBe(1);
  });
});

describe("event_seq resync", () => {
  test("gap fires onGap but still delivers newest truth", () => {
    const b = mockBridge();
    const gaps: unknown[] = [];
    const payloads: unknown[] = [];
    b.onGap((g) => gaps.push(g));
    b.listen("tab-changed", (e) => payloads.push(e.payload));
    expect(b.ingestEvent("tab-changed", { a: 1 }, "evt-0001", 1)).toBe(true);
    expect(b.ingestEvent("tab-changed", { a: 2 }, "evt-0002", 2)).toBe(true);
    // Skip seq 3 -> gap.
    expect(b.ingestEvent("tab-changed", { a: 4 }, "evt-0004", 4)).toBe(false);
    expect(gaps).toEqual([{ expected: 3, got: 4, channel: "tab-changed" }]);
    expect(b.getGapCount()).toBe(1);
    expect(payloads).toHaveLength(3);
    expect(b.getLastSeq()).toBe(4);
  });

  test("raw evt frames pass the version gate", () => {
    const b = mockBridge();
    const ok = b.ingestFrame({
      v: 1, id: "evt-0001", kind: "evt", name: "tab-changed", seq: 1, payload: {},
    });
    expect(ok).toBe(true);
    expect(() => b.ingestFrame({ v: 999, id: "x", kind: "evt", name: "y" })).toThrow();
  });
});

describe("mock host", () => {
  test("emits monotonic event_seq", () => {
    const host = new MockHost();
    expect(host.emitEvent("tab-changed")).toBe(1);
    expect(host.emitEvent("tab-changed")).toBe(2);
    expect(host.getSeq()).toBe(2);
  });

  test("reset clears tabs and seq", async () => {
    const host = new MockHost();
    await host.handle({ v: 1, id: "r1", kind: "req", name: "tabs_open", payload: {} });
    host.reset();
    expect(host.getSeq()).toBe(0);
  });
});

describe("host transport", () => {
  test("routes tab commands to Host modules (snake_case args)", async () => {
    const calls: unknown[] = [];
    const fake = {
      Tabs: {
        create: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { astra_tab_id: "tab-9", url: args["url"] };
        },
      },
      Navigation: {},
      Panes: {},
      Boot: {},
      Commands: {},
      Keymap: {},
      Work: {},
      Downloads: {},
      Media: {},
      Notes: {},
      Bookmarks: {},
      Time: {},
      HistoryCall: {},
      addEventListener: () => () => {},
      eventSeq: () => 0,
    };
    const dispatch = createHostDispatch(fake as never);
    const b = new Bridge({ mode: "host", dispatch, newId: () => "req-1" });
    const res = await b.invoke("tabs_open", { background: true });
    expect(res).toEqual({ astra_tab_id: "tab-9", url: undefined });
    expect(calls[0]).toMatchObject({ background: true, request_id: "req-1" });
  });

  test("unrouted commands fail fast with unknown_command", async () => {
    const fake = {
      Tabs: {}, Navigation: {}, Panes: {}, Boot: {}, Sidebar: {}, WebExtensions: {},
      Commands: {}, Keymap: {}, Work: {}, Downloads: {}, Media: {},
      Notes: {},
      Bookmarks: {},
      Time: {},
      HistoryCall: {},
      addEventListener: () => () => {},
      eventSeq: () => 0,
    };
    const b = new Bridge({ mode: "host", dispatch: createHostDispatch(fake as never) });
    await expect(b.invoke("blocker_status")).rejects.toMatchObject({ code: "unknown_command" });
  });

  test("routes sidebar + extension commands to new Host modules", async () => {
    const calls: unknown[] = [];
    const fake = {
      Tabs: {}, Navigation: {}, Panes: {}, Boot: {},
      Sidebar: {
        setHidden: async (args: Record<string, unknown>) => {
          calls.push(["setHidden", args]);
          return { hidden: args["hidden"] };
        },
      },
      WebExtensions: {
        list: async () => {
          calls.push(["list"]);
          return [];
        },
      },
      addEventListener: () => () => {},
      eventSeq: () => 0,
    };
    const b = new Bridge({ mode: "host", dispatch: createHostDispatch(fake as never), newId: () => "req-2" });
    await expect(b.invoke("sidebar_set_hidden", { hidden: true })).resolves.toEqual({ hidden: true });
    await expect(b.invoke("web_extension_list")).resolves.toEqual([]);
    expect(calls[0]).toMatchObject(["setHidden", { hidden: true, request_id: "req-2" }]);
  });

  test("host mode without dispatch throws", () => {
    expect(() => new Bridge({ mode: "host" })).toThrow(BridgeError);
  });
});
