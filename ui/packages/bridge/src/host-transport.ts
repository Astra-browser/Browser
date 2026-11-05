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
  Zoom: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Keymap: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Work: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Downloads: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Profiles: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Media: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  MediaImport: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Notes: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Bookmarks: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Time: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  HistoryCall: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  System: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Resources: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Search: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  PageSource: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  DialogPrompts: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  Permissions: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
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

const TAB_ARG: Record<string, string> = { id: "astra_tab_id" };

const ROUTES: Record<string, Route> = {
  tabs_open: ["Tabs", "create"],
  tabs_bootstrap: ["Tabs", "bootstrap"],
  tabs_close: ["Tabs", "close", TAB_ARG],
  // Sleeping tabs: the host driver sleeps them on its own timer; these two
  // are the explicit verbs for a surface or a live probe to use the same path.
  tabs_discard: ["Tabs", "discard", TAB_ARG],
  tabs_wakeup: ["Tabs", "wakeup", TAB_ARG],
  tabs_activate: ["Tabs", "select", TAB_ARG],
  tabs_answer_sign_in: ["DialogPrompts", "answerAuth", TAB_ARG],
  tabs_answer_page_request: ["Tabs", "answerPageRequest", TAB_ARG],
  tabs_continue_past_certificate: ["DialogPrompts", "answerCert", TAB_ARG],
  tabs_navigate: ["Navigation", "loadURL", { ...TAB_ARG, input: "url" }],
  tabs_back: ["Navigation", "goBack", TAB_ARG],
  tabs_forward: ["Navigation", "goForward", TAB_ARG],
  tabs_reload: ["Navigation", "reload", TAB_ARG],
  panel_hide: ["Panes", "hide"],
  panel_ready: ["Panes", "list"],
  ui_ready: ["Boot", "handshake"],
  sidebar_set_width: ["Sidebar", "setWidth"],
  sidebar_set_hidden: ["Sidebar", "setHidden"],
  sidebar_peek: ["Sidebar", "peek"],
  web_extension_list: ["WebExtensions", "list"],
  web_extension_set_enabled: ["WebExtensions", "setEnabled"],
  web_extension_uninstall: ["WebExtensions", "uninstall"],
  web_extension_open_options: ["WebExtensions", "openOptions"],
  web_extension_prepare: ["WebExtensions", "prepare"],
  web_extension_retry: ["WebExtensions", "retry"],
  web_extension_review_update: ["WebExtensions", "reviewUpdate"],
  web_extension_set_access: ["WebExtensions", "setAccess"],
  web_extension_set_pinned: ["WebExtensions", "setPinned"],
  web_extension_answer_access: ["WebExtensions", "answerAccess"],
  web_extension_store_button: ["WebExtensions", "storeButton"],
  web_extension_choose_file: ["WebExtensions", "chooseFile"],
  web_extension_prepare_file: ["WebExtensions", "prepareFile"],
  web_extension_confirm: ["WebExtensions", "confirm"],
  web_extension_cancel: ["WebExtensions", "cancel"],
  setting_get: ["Settings", "get"],
  setting_set: ["Settings", "set"],
  zoom_call: ["Zoom", "call"],
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
  profiles_get: ["Profiles", "get"],
  profiles_create: ["Profiles", "create"],
  profiles_rename: ["Profiles", "rename"],
  profiles_delete: ["Profiles", "remove"],
  profiles_set_avatar: ["Profiles", "setAvatar"],
  profile_avatar_pick: ["Profiles", "avatarPick"],
  profiles_switch: ["Profiles", "switch"],
  media_player: ["Media", "player"],
  media_import: ["MediaImport", "import"],
  tab_set_muted: ["Tabs", "setMuted", TAB_ARG],
  // Keep / let go and place in one call: the app's drag verb.
  tabs_set_essential: ["Tabs", "setEssential", TAB_ARG],
  note_call: ["Notes", "call"],
  bookmark_call: ["Bookmarks", "call"],
  time_call: ["Time", "call"],
  focus_control: ["Time", "focus"],
  history_call: ["HistoryCall", "call"],
  about_info: ["System", "aboutInfo"],
  system_clock_24h: ["System", "systemClock24h"],
  update_status: ["System", "updateStatus"],
  update_check: ["System", "updateCheck"],
  default_browser_status: ["System", "defaultBrowserStatus"],
  login_item_status: ["System", "loginItemStatus"],
  ui_info: ["System", "uiInfo"],
  resource_call: ["Resources", "call"],
  page_source: ["PageSource", "pageSource", { id: "tab_id" }],
  page_find: ["Navigation", "pageFind"],
  browser_open_url: ["Search", "openUrl"],
  newtab_search_context: ["Search", "newtabContext", { tab_id: "tabId" }],
  newtab_search: ["Search", "newtabSearch"],
  newtab_run: ["Search", "newtabRun"],
  newtab_cancel: ["Search", "newtabCancel"],
  launcher_search: ["Search", "launcherSearch"],
  launcher_run: ["Search", "launcherRun"],
  spaces_create: ["Tabs", "createSpace"],
  spaces_update: ["Tabs", "updateSpace"],
  spaces_delete: ["Tabs", "deleteSpace"],
  spaces_reorder: ["Tabs", "reorderSpace"],
  spaces_switch: ["Tabs", "switchSpace"],
  spaces_step: ["Tabs", "stepSpace"],
  spaces_move_tab: ["Tabs", "moveTabToSpace"],
  // The app's prompt token is the capability, so it travels as `prompt_id`;
  // the envelope `request_id` is the command correlation id, not the fence.
  page_permission_respond: ["Permissions", "respond", { request_id: "prompt_id" }],
  page_permission_card_host: ["Permissions", "cardHost"],
  operation_status: ["Operations", "status"],
  operations_reconcile: ["Operations", "reconcile"],
  operation_acknowledge: ["Operations", "acknowledge"],
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
