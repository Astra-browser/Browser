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
import type { Envelope } from "./proto.js";

export interface HostModules {
  Tabs: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Navigation: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Panes: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Boot: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Sidebar: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  WebExtensions: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Settings: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Accounts: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Commands: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Keymap: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Work: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Downloads: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Media: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Notes: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  addEventListener: (fn: (event: { event_seq: number; type: string; data: unknown }) => void) => () => void;
  eventSeq: () => number;
}

/** Wire command -> `[module, method, argMap]`. Args are camelCase from the UI. */
const ROUTES: Record<string, [keyof Omit<HostModules, "addEventListener" | "eventSeq">, string]> = {
  tabs_open: ["Tabs", "create"],
  tabs_bootstrap: ["Tabs", "bootstrap"],
  tabs_close: ["Tabs", "close"],
  tabs_activate: ["Tabs", "select"],
  tabs_navigate: ["Navigation", "loadURL"],
  tabs_back: ["Navigation", "goBack"],
  tabs_forward: ["Navigation", "goForward"],
  tabs_reload: ["Navigation", "reload"],
  panel_hide: ["Panes", "hide"],
  panel_ready: ["Panes", "list"],
  ui_ready: ["Boot", "handshake"],
  sidebar_set_width: ["Sidebar", "setWidth"],
  sidebar_set_hidden: ["Sidebar", "setHidden"],
  web_extension_list: ["WebExtensions", "list"],
  setting_get: ["Settings", "get"],
  setting_set: ["Settings", "set"],
  account_get: ["Accounts", "get"],
  run_command: ["Commands", "run"],
  keymap_entries: ["Keymap", "entries"],
  keymap_bind: ["Keymap", "bind"],
  keymap_reset: ["Keymap", "reset"],
  keymap_record: ["Keymap", "record"],
  work_running: ["Work", "running"],
  work_call: ["Work", "call"],
  download_call: ["Downloads", "call"],
  download_open_access_settings: ["Downloads", "openAccessSettings"],
  media_player: ["Media", "player"],
  note_call: ["Notes", "call"],
};

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
    const [moduleName, method] = route;
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
      const data = await fn({
        ...(toSnakeArgs((req.payload ?? {}) as Record<string, unknown>)),
        request_id: req.id,
      });
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
