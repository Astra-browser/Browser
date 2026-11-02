/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was obtained with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API entry point. The versioned seam from plan §6.4: everything Astra
// owns talks to Firefox internals only through this module tree. P1-T05
// proved the `resource://astra/` registration resolves; P1-T10 split the
// stub into per-domain modules (Tabs, Navigation, Panes) over a shared
// event pump (Events); P2-T06 completes Host API v1 with Boot (handshake +
// version negotiation), Windows (multi-window model), extended Tabs
// (move/duplicate/pin/discard), Navigation (stop/zoom/find/print/reader),
// Panes (slots/rects/generation guards), gap-resync events (`eventsSince`),
// and the Content feedback path (progress listeners feed external loads
// back into the model). P3-T17 adds Sidebar (last-reported app sidebar
// state) and WebExtensions (`web_extension_list` stub) so the app's boot
// calls resolve instead of failing with `no host route`. All modules are
// pure logic with no Firefox
// internals (Content.sys.mjs is the single exception and is loaded
// separately by the shell), so Node contract tests import them by path.

import { addEventListener, bufferedCount, emit, eventSeq, eventsSince } from "./Events.sys.mjs";
import { Boot } from "./Boot.sys.mjs";
import { HOST_API_VERSION, Tabs, __resetTabsForTests } from "./Tabs.sys.mjs";
import { Navigation, __commitExternal, __resetNavigationForTests } from "./Navigation.sys.mjs";
import { Windows, __resetWindowsForTests } from "./Windows.sys.mjs";
import { Session, __resetSessionForTests } from "./Session.sys.mjs";
import { History, __resetHistoryForTests } from "./History.sys.mjs";
import { Panes, __resetPanesForTests } from "./Panes.sys.mjs";
import { Containers, __resetContainersForTests } from "./Containers.sys.mjs";
import { Dialogs, __resetDialogsForTests } from "./Dialogs.sys.mjs";
import { ContentHide, __resetForTests as __resetContentHideForTests } from "./ContentHide.sys.mjs";
import { Settings, __resetSettingsForTests } from "./Settings.sys.mjs";
import { Accounts } from "./Accounts.sys.mjs";
import { Sidebar, __resetSidebarForTests } from "./Sidebar.sys.mjs";
import { WebExtensions, __resetWebExtensionsForTests } from "./WebExtensions.sys.mjs";
import { Commands } from "./Commands.sys.mjs";
import { Keymap } from "./Keymap.sys.mjs";
import { Work } from "./Work.sys.mjs";
import { Downloads } from "./Downloads.sys.mjs";
import { Media } from "./Media.sys.mjs";
import { Notes } from "./Notes.sys.mjs";
import { Bookmarks } from "./Bookmarks.sys.mjs";
import { Time } from "./Time.sys.mjs";
import { __resetEventsForTests } from "./Events.sys.mjs";

export {
  HOST_API_VERSION,
  Boot,
  Windows,
  Session,
  History,
  Tabs,
  Navigation,
  Panes,
  Containers,
  Dialogs,
  ContentHide,
  Settings,
  Accounts,
  Sidebar,
  WebExtensions,
  Commands,
  Keymap,
  Work,
  Downloads,
  Media,
  Notes,
  Bookmarks,
  Time,
  addEventListener,
  emit,
  eventSeq,
  eventsSince,
  bufferedCount,
  __commitExternal,
};

// Test-only reset so contract tests (P1-T11/P2-T06) start from a clean slate.
export function __resetForTests() {
  __resetTabsForTests();
  __resetNavigationForTests();
  __resetWindowsForTests();
  __resetSessionForTests();
  __resetHistoryForTests();
  __resetPanesForTests();
  __resetContainersForTests();
  __resetDialogsForTests();
  __resetContentHideForTests();
  __resetSettingsForTests();
  __resetSidebarForTests();
  __resetWebExtensionsForTests();
  __resetEventsForTests();
}
