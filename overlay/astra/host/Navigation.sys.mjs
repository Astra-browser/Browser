/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Navigation module (P1-T10). Moves the selected tab through its
// history stack and reports every commit as `nav.committed` + `tab.updated`
// (Appendix C). The P2-T06 host binding keeps this protocol and performs
// the load in a real `<browser>` element. Pure logic, no Firefox internals.

import { emit } from "./Events.sys.mjs";
import { HOST_API_VERSION, __historyFor, __pushHistory, __tabsState } from "./Tabs.sys.mjs";

function ok(request_id, data = {}) {
  return { request_id, host_api_version: HOST_API_VERSION, ...data };
}

function err(request_id, code, message) {
  return { request_id, host_api_version: HOST_API_VERSION, error: { code, message } };
}

function tabOf(astra_tab_id) {
  const { tabs, selectedId } = __tabsState();
  const id = astra_tab_id || selectedId;
  const tab = tabs.get(id);
  return { id, tab };
}

function commit(id, url, extra = {}) {
  const { tabs } = __tabsState();
  const tab = tabs.get(id);
  tab.url = url;
  const h = __historyFor(id);
  emit("nav.committed", { astra_tab_id: id, url, ...extra });
  emit("tab.updated", {
    astra_tab_id: id,
    url,
    title: tab.title,
    selected: tab.selected,
    canGoBack: h ? h.index > 0 : false,
    canGoForward: h ? h.index < h.entries.length - 1 : false,
  });
}

export const Navigation = {
  async loadURL({ request_id = "", astra_tab_id = "", url = "" } = {}) {
    const { id, tab } = tabOf(astra_tab_id);
    if (!tab) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id || "(none selected)"}`);
    }
    if (!url) {
      return err(request_id, "invalid_url", "url must be a non-empty string");
    }
    __pushHistory(id, url);
    commit(id, url);
    return ok(request_id, { astra_tab_id: id, url });
  },

  async goBack({ request_id = "", astra_tab_id = "" } = {}) {
    const { id, tab } = tabOf(astra_tab_id);
    if (!tab) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id || "(none selected)"}`);
    }
    const h = __historyFor(id);
    if (!h || h.index <= 0) {
      return ok(request_id, { astra_tab_id: id, went_back: false, url: tab.url });
    }
    h.index -= 1;
    commit(id, h.entries[h.index]);
    return ok(request_id, { astra_tab_id: id, went_back: true, url: tab.url });
  },

  async goForward({ request_id = "", astra_tab_id = "" } = {}) {
    const { id, tab } = tabOf(astra_tab_id);
    if (!tab) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id || "(none selected)"}`);
    }
    const h = __historyFor(id);
    if (!h || h.index >= h.entries.length - 1) {
      return ok(request_id, { astra_tab_id: id, went_forward: false, url: tab.url });
    }
    h.index += 1;
    commit(id, h.entries[h.index]);
    return ok(request_id, { astra_tab_id: id, went_forward: true, url: tab.url });
  },

  async reload({ request_id = "", astra_tab_id = "" } = {}) {
    const { id, tab } = tabOf(astra_tab_id);
    if (!tab) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id || "(none selected)"}`);
    }
    commit(id, tab.url, { reloaded: true });
    return ok(request_id, { astra_tab_id: id, reloaded: true, url: tab.url });
  },
};
