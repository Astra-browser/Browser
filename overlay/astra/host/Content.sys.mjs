/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was obtained with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API content binding (v1). The ONE place that touches a live
// content `<browser>`: it mirrors stub state (Tabs/Navigation) into a real
// XUL browser element placed by CSS inside Astra's layout, and drives loads
// through the stub so every navigation emits `nav.committed` + `tab.updated`.
//
// v1 adds the feedback path P1-T10 lacked: `attachTabBrowser` registers a
// tabs progress listener on a real tabbrowser so in-page navigations (link
// clicks, history.pushState, redirects) and title changes flow back into
// the model via `Navigation.__commitExternal` / `Tabs.setTitle` instead of
// silently diverging. Firefox internals are allowed here: everything under
// host/ is the versioned seam (§6.4).

import { addEventListener } from "./Events.sys.mjs";
import { Tabs, __applyExternalUpdate } from "./Tabs.sys.mjs";
import { Navigation, __commitExternal } from "./Navigation.sys.mjs";

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xhtml";

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

// Resolve the model tab currently selected. Shared by mount/navigate and
// the progress-listener callbacks below.
async function selectedTab(request_id) {
  const list = await Tabs.list({ request_id });
  return (list.tabs || []).find((t) => t.selected) ?? list.tabs[0] ?? null;
}

// Progress-listener factory: pure over (tabIdOf, commit, setTitle) so Node
// contract tests can drive it with fakes and the live binding passes the
// real tabbrowser mapping. `tabIdOf(browser)` maps a `<browser>` element
// to its `astra_tab_id` (null when untracked).
export function makeProgressListener({ tabIdOf, commit = __commitExternal, setTitle } = {}) {
  const resolveTitle = setTitle ?? ((id, title) => Tabs.setTitle({ astra_tab_id: id, title }));
  return {
    onLocationChange(browser, _progress, _request, location) {
      try {
        const id = tabIdOf ? tabIdOf(browser) : null;
        const url = location && location.spec ? location.spec : "";
        if (id && url) {
          commit(id, url);
        }
      } catch {
        // Progress callbacks must never break page loads.
      }
    },
    onTitleChange(browser, title) {
      try {
        const id = tabIdOf ? tabIdOf(browser) : null;
        if (id && typeof title === "string" && title !== "") {
          resolveTitle(id, title);
        }
      } catch {
        // Ignore listener failures, as above.
      }
    },
    onStatusChange() {},
    onStateChange() {},
    onSecurityChange() {},
  };
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
    const tab = await selectedTab(request_id);
    if (!tab) {
      const created = await Tabs.create({ request_id, url });
      return { astra_tab_id: created.astra_tab_id, url };
    }
    return Navigation.loadURL({ request_id, astra_tab_id: tab.astra_tab_id, url });
  },

  // v1 feedback path: watch a real tabbrowser so external loads and title
  // changes update the model. `tabIdOf` maps a `<browser>` element to its
  // `astra_tab_id`; when omitted, events apply to the selected tab.
  // Returns `{ listener, detach }`. No-ops (null listener) when the
  // tabbrowser does not support progress listeners (e.g. Node tests).
  attachTabBrowser(tabbrowser, { tabIdOf = null } = {}) {
    if (
      !tabbrowser ||
      typeof tabbrowser.addTabsProgressListener !== "function" ||
      typeof tabbrowser.removeTabsProgressListener !== "function"
    ) {
      return { listener: null, detach() {} };
    }
    const mapFn =
      typeof tabIdOf === "function"
        ? tabIdOf
        : (browser) => {
            void browser;
            return null;
          };
    const listener = makeProgressListener({ tabIdOf: mapFn });
    tabbrowser.addTabsProgressListener(listener);
    return {
      listener,
      detach() {
        try {
          tabbrowser.removeTabsProgressListener(listener);
        } catch {
          // Detach is best-effort during teardown.
        }
      },
    };
  },

  // Live zoom apply: model state lives in Navigation (setZoom); this
  // mirrors it into a real browser element when available. Best-effort:
  // resolves false when no zoom manager is reachable.
  applyZoom(browser, zoom) {
    try {
      const win = browser?.ownerDocument?.defaultView;
      const ZoomManager = win?.ZoomManager;
      if (!ZoomManager || typeof zoom !== "number" || !Number.isFinite(zoom)) {
        return false;
      }
      ZoomManager.setZoomForBrowser(browser, zoom);
      return true;
    } catch {
      return false;
    }
  },

  // Live print dispatch for Navigation.print intent. Best-effort: resolves
  // false when PrintUtils is unreachable (model event already emitted).
  printPage(browser) {
    try {
      const win = browser?.ownerDocument?.defaultView;
      const PrintUtils = win?.PrintUtils;
      if (!PrintUtils || typeof PrintUtils.startPrintWindow !== "function") {
        return false;
      }
      PrintUtils.startPrintWindow(browser.browsingContext, { printToFile: false });
      return true;
    } catch {
      return false;
    }
  },
};

function safeSpec(browser) {
  try {
    return browser.currentURI ? browser.currentURI.spec : "";
  } catch {
    return "";
  }
}

export { __applyExternalUpdate };
