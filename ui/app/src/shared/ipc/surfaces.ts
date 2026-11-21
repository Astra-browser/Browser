/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Typed callers for the native-surface commands added after the generated
// binding snapshot. Every name here is routed in
// `ui/packages/bridge/src/host-transport.ts` and asserted by
// `tests/contract/native_surfaces.mjs`, so an un-routed call fails a test
// rather than becoming a silent `unknown_command` in the app.

import { invoke } from "@tauri-apps/api/core";

export interface SplitOpenView {
  split?: boolean;
  opened?: boolean;
  members?: string[];
  panes?: number;
  astra_tab_id?: string;
  placement?: string;
  accepted?: boolean;
  reason?: string;
  restored?: boolean;
}

export interface SplitArrangement {
  id: string;
  name: string;
  space_id: string;
  ratio: number;
  panes: Array<{ url: string; title: string }>;
  created_at: number;
}

export interface SplitArrangementList {
  version: number;
  arrangements: SplitArrangement[];
}

/** Fire-and-forget intent: the native projection is the confirmation. */
const fire = (task: Promise<unknown>) => void task.catch(() => {});

export const splitOpenUrl = (url: string, placement: "left" | "right" = "right", pane = "") =>
  invoke<SplitOpenView>("split_open_url", { url, mode: "split", placement, pane });

/** Split two named tabs. `source` stays the pane in front; `other` joins. */
export const splitOpen = (source: string, other: string) =>
  invoke<SplitOpenView>("tabs_split", { source, other });

/** End the split that owns `id`, even when another tab is in front. */
export const splitUnsplit = (id: string) => invoke<SplitOpenView>("tabs_unsplit", { id });

export const splitReplace = (pane: string, other: string) =>
  invoke<SplitOpenView>("split_replace", { pane, other });

export const splitReplaceUrl = (pane: string, url: string) =>
  invoke<SplitOpenView>("split_replace", { pane, url });

export const splitSaveArrangement = (name: string) =>
  invoke<{ saved: boolean; arrangement: SplitArrangement }>("split_bookmark_save", { name });

export const splitArrangements = () => invoke<SplitArrangementList>("split_bookmark_list", {});

export const splitRestoreArrangement = (id: string) =>
  invoke<SplitOpenView>("split_bookmark_restore", { id });

export const splitDeleteArrangement = (id: string) => fire(invoke("split_bookmark_delete", { id }));

// --- Peek ------------------------------------------------------------------

export interface PeekView {
  id: string;
  tab_id: string;
  url: string;
  title: string;
  space_id: string;
  source: string;
  private: boolean;
  captured_at: number;
  image: string | null;
  thumbnail: string | null;
}

export interface PeekConfig {
  enabled: boolean;
  trigger: string;
  delay: number;
  size: string;
  position: string;
  scale: number;
  restore: boolean;
  closeOnLeave: boolean;
  showUrl: boolean;
  showTitle: boolean;
}

export interface PeekState {
  peeks: PeekView[];
  config: PeekConfig;
  private?: boolean;
}

export const peekOpen = (target: {
  tab_id?: string;
  url?: string;
  title?: string;
  source?: string;
}) => invoke<{ id: string; peek: PeekView }>("peek_open", target);

export const peekClose = (id: string) => invoke("peek_close", { id });
export const peekCloseAll = () => invoke("peek_close_all", {});
export const peekCapture = (id: string) => invoke("peek_capture", { id });
export const peekList = () => invoke<PeekState>("peek_list", {});
export const peekOpenTab = (id: string) => invoke("peek_open_tab", { id });
export const peekOpenSplit = (id: string) => invoke("peek_open_split", { id });
export const peekRestore = () => invoke<{ restored: number }>("peek_restore", {});
export const peekConfigure = (config: Partial<PeekConfig>) =>
  invoke<{ config: PeekConfig }>("peek_configure", { config });

// --- Space isolation -------------------------------------------------------

export interface SpaceHistoryStatus {
  space_id: string;
  entries: number;
  total: number;
  scope: string;
}

export const spaceHistoryStatus = (spaceId = "") =>
  invoke<SpaceHistoryStatus>("space_history_status", { spaceId });

export const spaceHistoryClear = (spaceId = "") =>
  invoke<{ cleared: number; removed: number; space_id: string }>("space_history_clear", {
    spaceId,
  });

export interface SpaceExtensionView {
  id: string;
  name: string;
  version: string;
  icon: string | null;
  enabled: boolean;
  assigned: boolean;
  can_toggle: boolean;
}

export const spaceExtensions = (spaceId = "") =>
  invoke<{ space_id: string; per_space: boolean; extensions: SpaceExtensionView[] }>(
    "space_extensions_list",
    { spaceId },
  );

export const setSpaceExtension = (spaceId: string, id: string, enabled: boolean) =>
  invoke("space_extensions_assign", { spaceId, id, enabled });

export const copySpaceExtensions = (fromSpace: string, toSpace: string) =>
  invoke("space_extensions_copy", { fromSpace, toSpace });

export interface NativeTabGroupView {
  id: string;
  label: string;
  color: string | null;
  collapsed: boolean;
  members: string[];
}

export const createTabGroup = (id: string, label = "") =>
  invoke<{ created: boolean; group: NativeTabGroupView }>("tab_group_create", { id, label });

export const collapseTabGroup = (groupId: string, collapsed: boolean) =>
  invoke("tab_group_collapse", { groupId, collapsed });

export const ungroupTabs = (groupId: string) => invoke("tab_group_ungroup", { groupId });

export const cloneTabToSpace = (
  id: string,
  space: string,
  includeHistory = false,
  background = true,
) =>
  invoke<{ cloned: boolean; astra_tab_id: string; space_id: string; url: string }>(
    "tabs_clone_to_space",
    { id, space, includeHistory, background },
  );

// --- Session history -------------------------------------------------------

/** The pages behind and ahead of a tab, as the engine kept them. */
export interface TabHistoryView {
  index: number;
  entries: Array<{ url: string; title: string }>;
}

export const tabHistory = (id: string) => invoke<TabHistoryView>("tabs_history", { id });

export const tabHistoryGo = (id: string, index: number) =>
  invoke<{ astra_tab_id: string; moved: boolean; index?: number; url?: string }>(
    "tabs_history_go",
    {
      id,
      index,
    },
  );
