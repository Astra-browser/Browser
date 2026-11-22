/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host-mode dispatch (P2-T08). In Firefox chrome the UI talks to the Host
// API modules under `overlay/astra/host/*.sys.mjs` (contract source, read
// via `resource://astra/...` at runtime). That mapping lives here behind a
// `dispatch` function so this package never imports `resource://` itself —
// the app wiring layer (`$shared/ipc/bridge.ts`) injects the loader, which
// keeps the package importable in Node/vitest/standalone builds.
//
//
// Route table: wire command -> Host module method. The table is built from
// `manifest.ts`, which owns every command and its state (D-55). A command with
// no route fails fast with `unknown_command` instead of hanging the UI.

import { PROTOCOL_VERSION } from "./proto.js";
import { COMMAND_MANIFEST, isRouted, toRoute } from "./manifest.js";
import type { HostModules, Route } from "./host-modules.js";
import type { Envelope } from "./proto.js";

export type { HostModules } from "./host-modules.js";

/**
 * The route table, built from the command manifest (D-55). A row that is not
 * `routed` has no entry, so dispatch refuses it with `unknown_command`.
 * Insertion order follows the manifest, so the table is the same table it was
 * before the move.
 */
export const ROUTES: Record<string, Route> = Object.fromEntries(
  COMMAND_MANIFEST.filter(isRouted).map((entry) => [entry.name, toRoute(entry)]),
);

function toSnakeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    out[key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`)] = value;
  }
  return out;
}

/**
 * Build a `DispatchFn` over loaded Host modules. `onHostEvent` receives raw
 * host events (`{ event_seq, type, data }`) for the bridge event pump.
 */
export function createHostDispatch(
  host: HostModules,
  onHostEvent?: (event: { event_seq: number; type: string; data: unknown }) => void,
): (req: Envelope) => Promise<Envelope> {
  if (onHostEvent) host.addEventListener(onHostEvent);
  return async (req: Envelope): Promise<Envelope> => {
    const route = ROUTES[req.name];
    if (!route) {
      return {
        v: PROTOCOL_VERSION,
        id: req.id,
        kind: "res",
        name: req.name,
        payload: {},
        error: { code: "unknown_command", message: `no host route for ${req.name}` },
      };
    }
    const [moduleName, method, argMap] = route;
    const fn = host[moduleName][method];
    if (typeof fn !== "function") {
      return {
        v: PROTOCOL_VERSION,
        id: req.id,
        kind: "res",
        name: req.name,
        payload: {},
        error: { code: "unknown_command", message: `host has no ${moduleName}.${method}` },
      };
    }
    try {
      const args = toSnakeArgs((req.payload ?? {}) as Record<string, unknown>);
      if (argMap) {
        for (const [from, to] of Object.entries(argMap)) {
          if (from in args) {
            args[to] = args[from];
            delete args[from];
          }
        }
      }
      const data = await fn({ ...args, request_id: req.id });
      return { v: PROTOCOL_VERSION, id: req.id, kind: "res", name: req.name, payload: data === undefined ? {} : data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        v: PROTOCOL_VERSION,
        id: req.id,
        kind: "res",
        name: req.name,
        payload: {},
        error: { code: "host_error", message },
      };
    }
  };
}

/** Commands the host route table covers (extend with P2-T06 bindings). */
export function hostRoutedCommands(): string[] {
  return Object.keys(ROUTES);
}
