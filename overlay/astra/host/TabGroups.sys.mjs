/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Native tab groups, exposed to Astra's sidebar.
//
// The engine owns the group (identity, colour, label, collapse state); this
// module creates, collapses and dissolves groups on the real `gBrowser`
// elements and never keeps a parallel group model. The projection itself is
// written by Content (`__setTabGroup`), because it already owns the native
// tab map.

import { HOST_API_VERSION, err, ok } from "./Envelope.sys.mjs";
import { __setTabGroup, emitItemsChanged } from "./Tabs.sys.mjs";
import { __nativeBinding } from "./SplitView.sys.mjs";

function groupElements(binding) {
  try {
    return [...(binding?.gb?.tabGroups ?? [])];
  } catch {
    return [];
  }
}

/** Mirror a native group into the tab projection immediately. */
function publishGroup(binding, group) {
  const view = group ? viewOf(group, binding) : null;
  let changed = false;
  if (view) {
    for (const id of view.members) changed = __setTabGroup(id, view) || changed;
  }
  if (changed) emitItemsChanged();
  return view;
}

function groupById(binding, id) {
  return groupElements(binding).find((group) => String(group.id) === String(id)) ?? null;
}

function viewOf(group, binding) {
  return {
    id: String(group.id ?? ""),
    label: String(group.label ?? ""),
    color: typeof group.color === "string" ? group.color : null,
    collapsed: group.collapsed === true,
    members: (group.tabs ?? []).map((tab) => binding.idOf.get(tab) ?? "").filter(Boolean),
  };
}

export const TabGroups = {
  async create({ request_id = "", id = "", label = "", window_id = "" } = {}) {
    const binding = __nativeBinding(window_id);
    if (!binding) return err(request_id, "no_window", "no chrome window is bound");
    const selected = binding.gb.selectedTab;
    const other = binding.tabOf.get(id);
    if (!selected || !other) return err(request_id, "no_such_tab", "both tabs must be live");
    if (selected === other) return err(request_id, "same_tab", "a group needs two tabs");
    if ((selected.userContextId ?? 0) !== (other.userContextId ?? 0)) {
      return err(request_id, "space_mismatch", "a group never spans spaces");
    }
    let group = null;
    try {
      group = binding.gb.addTabGroup([selected, other], {
        label: String(label ?? ""),
        isUserTriggered: false,
      });
    } catch {
      group = null;
    }
    if (!group) return err(request_id, "group_refused", "the engine refused the group");
    return ok(request_id, { created: true, group: publishGroup(binding, group) });
  },

  async list({ request_id = "", window_id = "" } = {}) {
    const binding = __nativeBinding(window_id);
    if (!binding) return err(request_id, "no_window", "no chrome window is bound");
    return ok(request_id, { groups: groupElements(binding).map((group) => viewOf(group, binding)) });
  },

  async collapse({ request_id = "", group_id = "", collapsed = true, window_id = "" } = {}) {
    const binding = __nativeBinding(window_id);
    if (!binding) return err(request_id, "no_window", "no chrome window is bound");
    const group = groupById(binding, group_id);
    if (!group) return err(request_id, "no_such_group", "unknown group");
    group.collapsed = collapsed === true;
    return ok(request_id, { group: publishGroup(binding, group) });
  },

  async ungroup({ request_id = "", group_id = "", window_id = "" } = {}) {
    const binding = __nativeBinding(window_id);
    if (!binding) return err(request_id, "no_window", "no chrome window is bound");
    const group = groupById(binding, group_id);
    if (!group) return err(request_id, "no_such_group", "unknown group");
    const members = (group.tabs ?? []).map((tab) => binding.idOf.get(tab) ?? "").filter(Boolean);
    try {
      group.ungroupTabs?.();
    } catch {
      return err(request_id, "group_refused", "the engine refused to dissolve the group");
    }
    let changed = false;
    for (const id of members) changed = __setTabGroup(id, null) || changed;
    if (changed) emitItemsChanged();
    return ok(request_id, { ungrouped: true, members });
  },
};
