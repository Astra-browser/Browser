/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The host module surface and the route shape. Types only.
//
// Both `manifest.ts` and `host-transport.ts` need these, and the transport needs
// the manifest's data. Keeping the types in either module made a type cycle, so
// they live here instead (D-55).

/** One host module: method name -> async handler over the wire arguments. */
export type HostModuleMethods = Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
>;

/** The modules the chrome can call. One key per `overlay/astra/host/*.sys.mjs`. */
export interface HostModules {
  Tabs: HostModuleMethods;
  Navigation: HostModuleMethods;
  Panes: HostModuleMethods;
  SplitView: HostModuleMethods;
  Peek: HostModuleMethods;
  SpaceHistory: HostModuleMethods;
  SpaceExtensions: HostModuleMethods;
  SpaceClone: HostModuleMethods;
  TabGroups: HostModuleMethods;
  Boot: HostModuleMethods;
  Sidebar: HostModuleMethods;
  WebExtensions: HostModuleMethods;
  Settings: HostModuleMethods;
  Accounts: HostModuleMethods;
  Commands: HostModuleMethods;
  Zoom: HostModuleMethods;
  Keymap: HostModuleMethods;
  Launcher: HostModuleMethods;
  Work: HostModuleMethods;
  Downloads: HostModuleMethods;
  Profiles: HostModuleMethods;
  Media: HostModuleMethods;
  MediaGallery: HostModuleMethods;
  MediaImport: HostModuleMethods;
  Notes: HostModuleMethods;
  Bookmarks: HostModuleMethods;
  Time: HostModuleMethods;
  HistoryCall: HostModuleMethods;
  Favicons: HostModuleMethods;
  System: HostModuleMethods;
  Migration: HostModuleMethods;
  Resources: HostModuleMethods;
  Search: HostModuleMethods;
  PageSource: HostModuleMethods;
  Passkeys: HostModuleMethods;
  TabHistory: HostModuleMethods;
  DialogPrompts: HostModuleMethods;
  PageDialogs: HostModuleMethods;
  Permissions: HostModuleMethods;
  BrowsingData: HostModuleMethods;
  Blocker: HostModuleMethods;
  Privacy: HostModuleMethods;
  Operations: HostModuleMethods;
  addEventListener: (fn: (event: { event_seq: number; type: string; data: unknown }) => void) => () => void;
  eventSeq: () => number;
}

/** A module key that can answer a route. */
export type HostModuleName = keyof Omit<HostModules, "addEventListener" | "eventSeq">;

/**
 * Wire command -> `[module, method, argMap]`. Args are camelCase from the UI.
 *
 * `argMap` renames a wire argument onto the Host API's own name after the
 * camelCase -> snake_case pass. The UI speaks the product's vocabulary (`id`,
 * `input`); the Host API speaks the tab's (`astra_tab_id`, `url`). Without the
 * map the call arrives well-formed but with an empty id, and the host answers
 * `no_such_tab` for a tab the person is looking at.
 */
export type Route = [HostModuleName, string, Record<string, string>?];
