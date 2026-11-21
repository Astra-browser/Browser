/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Contract seam: the manifest and the route table cannot drift (D-55).
//
// `tests/contract/wire_manifest.mjs` pins the manifest's own invariants (unique
// names, state partition, real decision reasons). This test pins the wiring:
// every routed row is the route the transport dispatches, with the same module,
// method and argument map, and no route exists that the manifest does not
// declare. It runs under bun, which resolves the package's `./x.js` imports.

import { describe, expect, test } from "bun:test";
import { ARG_MAPS, COMMAND_MANIFEST } from "./manifest.js";
import { ROUTES, createHostDispatch } from "./host-transport.js";
import { PROTOCOL_VERSION } from "./proto.js";

const routed = COMMAND_MANIFEST.filter((entry) => entry.state === "routed");

describe("the command manifest owns the routes", () => {
  test("the route table has exactly the manifest's routed names", () => {
    expect(Object.keys(ROUTES).sort()).toEqual(routed.map((entry) => entry.name).sort());
  });

  test("every routed row is the table's destination and argument map", () => {
    for (const entry of routed) {
      const expected =
        entry.args === "none"
          ? [entry.module, entry.method]
          : [entry.module, entry.method, ARG_MAPS[entry.args]];
      expect({ name: entry.name, route: ROUTES[entry.name] }).toEqual({
        name: entry.name,
        route: expected as never,
      });
    }
  });

  test("an unrouted command still fails fast with unknown_command", async () => {
    const refused = COMMAND_MANIFEST.find(
      (entry) => entry.state === "deferred" && entry.reason === "D-48",
    );
    expect(refused).toBeDefined();
    const host = {
      addEventListener: () => {},
      eventSeq: 0,
    } as never;
    const dispatch = createHostDispatch(host);
    const response = await dispatch({
      v: PROTOCOL_VERSION,
      id: "req-manifest-1",
      kind: "req",
      name: refused!.name,
      payload: {},
    });
    expect(response.error?.code).toBe("unknown_command");
  });
});
