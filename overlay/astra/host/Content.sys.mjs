/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API content binding (P1-T10). The ONE place that touches a live
// content `<browser>`: it mirrors stub state (Tabs/Navigation) into a real
// XUL browser element placed by CSS inside Astra's layout, and drives loads
// through the stub so every navigation emits `nav.committed` + `tab.updated`.
// In-page navigations (link clicks) do not yet feed back into the stub —
// P2-T06 binds progress listeners for that. Firefox internals are allowed
// here: everything under host/ is the versioned seam (§6.4).

import { addEventListener } from "./Events.sys.mjs";
import { Tabs } from "./Tabs.sys.mjs";
import { Navigation } from "./Navigation.sys.mjs";

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

// ESR 153 removed resource://gre/modules/Services.sys.mjs; chrome windows
// still expose the `Services` lazy global, so reach it through the owning
// window instead of importing a module that no longer exists.
function systemPrincipalOf(container) {
  const win = container.ownerDocument.defaultView;
  const Services = win && win.Services;
  if (!Services) {
    throw new Error("[astra-host] chrome Services global unavailable");
  }
  return Services.scriptSecurityManager.getSystemPrincipal();
}

export const Content = {
  // Mounts one content browser into `container` (an element in the chrome
  // document) and ensures exactly one live tab exists. Returns
  // `{ browser, detach }`. Safe to call once per window.
  async mount(container, { request_id = "content-mount" } = {}) {
    let list = await Tabs.list({ request_id });
    let tab = (list.tabs || []).find((t) => t.selected) ?? list.tabs[0];
    if (!tab) {
      const created = await Tabs.create({ request_id, url: "about:blank" });
      list = await Tabs.list({ request_id });
      tab = list.tabs.find((t) => t.astra_tab_id === created.astra_tab_id);
    }

    const doc = container.ownerDocument;
    const principal = systemPrincipalOf(container);
    const browser = doc.createElementNS(XUL_NS, "browser");
    // Remote content browser: on ESR 153 a non-remote `type="content"`
    // browser created outside the tabbrowser has an inert docshell (loads
    // never commit, measured 2026-11-02). Remote is the only live path.
    browser.setAttribute("type", "content");
    browser.setAttribute("remote", "true");
    browser.setAttribute("remoteType", "web");
    browser.setAttribute("maychangeremoteness", "true");
    browser.setAttribute("flex", "1");
    browser.setAttribute("data-astra-browser", "content");
    container.append(browser);
    browser.fixupAndLoadURIString(tab.url, { triggeringPrincipal: principal });

    const selected = { id: tab.astra_tab_id };
    const off = addEventListener((event) => {
      if (event.type === "tab.updated" && event.data.selected) {
        selected.id = event.data.astra_tab_id;
      }
      if (event.type === "nav.committed" && event.data.astra_tab_id === selected.id) {
        const current = safeSpec(browser);
        if (current !== event.data.url) {
          browser.fixupAndLoadURIString(event.data.url, { triggeringPrincipal: principal });
        }
      }
    });

    return {
      browser,
      detach() {
        off();
        browser.remove();
      },
    };
  },

  // URL-bar actions: every path goes through the stub; the mounted browser
  // follows via the nav.committed event above.
  async navigate(url, { request_id = "content-nav" } = {}) {
    const list = await Tabs.list({ request_id });
    const tab = (list.tabs || []).find((t) => t.selected) ?? list.tabs[0];
    if (!tab) {
      const created = await Tabs.create({ request_id, url });
      return { astra_tab_id: created.astra_tab_id, url };
    }
    return Navigation.loadURL({ request_id, astra_tab_id: tab.astra_tab_id, url });
  },
};

function safeSpec(browser) {
  try {
    return browser.currentURI ? browser.currentURI.spec : "";
  } catch {
    return "";
  }
}
