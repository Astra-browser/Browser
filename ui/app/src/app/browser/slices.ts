/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { theme } from "$domain/appearance";
import { blocker } from "$domain/blocker";
import { extensions } from "$domain/extensions";
import { favicons } from "$domain/favicons";
import { keymap } from "$domain/keymap";
import { layout } from "$domain/layout";
import { mediaPlayer } from "$domain/media-player";
import { operations } from "$domain/operations";
import { pagePermissions } from "$domain/permissions";
import { preferences } from "$domain/preferences";
import { runtime } from "$domain/runtime";
import { surface as browserPage } from "$domain/surface";
import { tabs } from "$domain/tabs";
import { focus } from "$domain/time";
import { uiCommands } from "$domain/ui-commands";
import { pageDialogs } from "$features/dialogs";
import * as tools from "$session/tools.svelte";
import type { Slice } from "$shared/lib/lifecycle";

/**
 * Every UI slice that owns a document-lifetime listener, in the order the
 * browser starts them. Each entry is the one contract from
 * `shared/lib/lifecycle.ts`; no slice keeps its own generation counter.
 */
export const browserSlices: readonly { id: string; slice: Slice }[] = [
  { id: "theme", slice: theme.slice },
  { id: "tools", slice: tools.slice },
  { id: "surface", slice: browserPage.slice },
  { id: "preferences", slice: preferences.slice },
  { id: "runtime", slice: runtime.slice },
  { id: "media-player", slice: mediaPlayer.slice },
  { id: "focus", slice: focus.slice },
  { id: "extensions", slice: extensions.slice },
  { id: "page-permissions", slice: pagePermissions.slice },
  { id: "page-dialogs", slice: pageDialogs.slice },
  { id: "favicons", slice: favicons.slice },
  { id: "tabs", slice: tabs.slice },
  { id: "ui-commands", slice: uiCommands.slice },
  { id: "keymap", slice: keymap.slice },
  { id: "operations", slice: operations.slice },
  { id: "blocker", slice: blocker.slice },
  { id: "layout", slice: layout.slice },
];
