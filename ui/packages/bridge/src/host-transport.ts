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
// Route table: wire command -> Host module method. Only the domains P1-T10
// specified (Tabs/Navigation/Panes/Boot) are routed; the remaining surface
// resolves once later phases specify it (P2-T06 live bindings). Unrouted
// commands fail fast with `unknown_command` instead of hanging the UI.

import { PROTOCOL_VERSION } from "./proto.js";
import { ARG_MAPS, COMMAND_MANIFEST } from "./manifest.js";
import type { Envelope } from "./proto.js";

export interface HostModules {
  Tabs: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Navigation: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Panes: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  SplitView: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Peek: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  SpaceHistory: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  SpaceExtensions: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  SpaceClone: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  TabGroups: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Boot: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Sidebar: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  WebExtensions: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Settings: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Accounts: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Commands: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Zoom: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Keymap: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Launcher: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Work: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Downloads: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Profiles: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Media: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  MediaGallery: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  MediaImport: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Notes: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Bookmarks: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Time: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  HistoryCall: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Favicons: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  System: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Migration: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Resources: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Search: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  PageSource: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Passkeys: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  TabHistory: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  DialogPrompts: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  PageDialogs: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Permissions: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  BrowsingData: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Blocker: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Privacy: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Operations: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  addEventListener: (fn: (event: { event_seq: number; type: string; data: unknown }) => void) => () => void;
  eventSeq: () => number;
}

/**
 * Wire command -> `[module, method, argMap]`. Args are camelCase from the UI.
 *
 * `argMap` renames a wire argument onto the Host API's own name after the
 * camelCase -> snake_case pass. The UI speaks the product's vocabulary (`id`,
 * `input`); the Host API speaks the tab's (`astra_tab_id`, `url`). Without the
 * map the call arrives well-formed but with an empty id, and the host answers
 * `no_such_tab` for a tab the person is looking at.
 */
type Route = [
  keyof Omit<HostModules, "addEventListener" | "eventSeq">,
  string,
  Record<string, string>?,
];

/**
 * The route table, built from the command manifest (D-55). A row that is not
 * `routed` has no entry, so dispatch refuses it with `unknown_command`.
 * Insertion order follows the manifest, so the table is the same table it was
 * before the move.
 */
export const ROUTES: Record<string, Route> = Object.fromEntries(
  COMMAND_MANIFEST.filter((entry) => entry.state === "routed").map(
    (entry): [string, Route] => [
      entry.name,
      entry.args === "none"
        ? [(entry.module as Route[0]), (entry.method as string)]
        : [(entry.module as Route[0]), (entry.method as string), ARG_MAPS[entry.args]],
    ],
  ),
) as Record<string, Route>;

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
