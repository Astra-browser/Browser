/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// P2-T02 TS tests (run: `bun test gen/` from crates/astra-proto).
// Mirrors the Rust unit tests: envelope version gate, unknown-field
// tolerance, and registry completeness (276 commands + 36 events).

import { describe, expect, test } from "bun:test";
import {
  COMMANDS,
  EVENT_RENAMES,
  EVENTS,
  PROTOCOL_VERSION,
  makeRequest,
  parseEnvelope,
  type Envelope,
} from "./astra-proto";

describe("protocol version", () => {
  test("is v1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  test("wrong version throws (fail fast)", () => {
    expect(() =>
      parseEnvelope({ v: 999, id: "a", kind: "req", name: "tabs_navigate", payload: {} }),
    ).toThrow(/unsupported version/);
  });

  test("unknown fields are ignored", () => {
    const env = parseEnvelope({
      v: 1,
      id: "a",
      kind: "req",
      name: "tabs_navigate",
      payload: {},
      future_field: "x",
    });
    expect(env.name).toBe("tabs_navigate");
  });

  test("malformed envelopes throw", () => {
    expect(() => parseEnvelope(null)).toThrow();
    expect(() => parseEnvelope({ v: 1, id: 1, kind: "req", name: "x", payload: {} })).toThrow();
    expect(() => parseEnvelope({ v: 1, id: "a", kind: "nope", name: "x", payload: {} })).toThrow();
  });
});

describe("envelope round trip", () => {
  test("makeRequest -> parseEnvelope", () => {
    const req: Envelope = makeRequest("tabs_navigate", { id: "t", input: "u" }, "req-1");
    const back = parseEnvelope(JSON.parse(JSON.stringify(req)));
    expect(back).toEqual(req);
  });
});

describe("registry completeness", () => {
  test("276 commands", () => {
    expect(COMMANDS.length).toBe(276);
    expect(new Set(COMMANDS).size).toBe(276);
    expect(COMMANDS).toContain("tabs_navigate");
    expect(COMMANDS).toContain("work_call");
  });

  test("36 events, renames applied", () => {
    expect(EVENTS.length).toBe(36);
    expect(new Set(EVENTS).size).toBe(36);
    expect(EVENTS).toContain("tab-changed");
    expect(EVENTS).toContain("astra:account-changed");
    expect(EVENTS.find((e) => e.startsWith("prev:"))).toBeUndefined();
    expect(Object.keys(EVENT_RENAMES).length).toBe(10);
    expect(EVENT_RENAMES["prev:swipe"]).toBe("astra:swipe");
  });
});
