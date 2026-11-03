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
import {
  ContentHide,
  createBlockerCosmeticProvider,
  createOverrideStoreAdapter,
  installLiveHiding,
  setCosmeticProvider,
  setStoreAdapter,
} from "./ContentHide.sys.mjs";

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

// Schemes the content stage will load. A tab's address can come from a
// caller (`Tabs.create`), a restored session or the page itself, so the
// decision to hand an address to the browser belongs here, not in whoever
// asked: `data:`, `file:`, `javascript:`, `blob:`, `chrome:` and
// `resource:` would otherwise run in the page that this binding loads with
// the system principal.
const LOADABLE_SCHEMES = new Set(["http:", "https:"]);

/** True when `url` is an address the content browser may be pointed at. */
export function isLoadableUrl(url) {
  if (typeof url !== "string" || url === "") {
    return false;
  }
  try {
    return LOADABLE_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

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
  // Mounts the content browsers into `container` (an element in the chrome
  // document) and ensures exactly one live tab exists. One `<browser>` is
  // kept per page tab: switching tabs then shows the page that was already
  // there instead of reloading it from the network, which is what made a
  // switch back look like a dead black stage for the length of a page load.
  // Returns `{ browser, browsers, detach }`. Safe to call once per window.
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
    /** astra_tab_id -> { browser, requested, poll, abort }; one page per tab,
     *  kept alive. `poll` is the load watcher and `abort` owns the element's
     *  listeners, so every browser releases everything it started. */
    const browsers = new Map();
    /** Every timer this mount owns, so teardown leaves none behind. */
    const timers = new Set();
    /** The tab whose browser is in front ("" when a New Tab owns the stage). */
    let activeId = "";

    const activeBrowser = () => browsers.get(activeId)?.browser ?? null;

    const setActive = (id) => {
      activeId = id;
      for (const [key, entry] of browsers) {
        try {
          if (key === id) {
            entry.browser.setAttribute("data-astra-browser", "content");
            entry.browser.removeAttribute("data-astra-browser-parked");
          } else {
            entry.browser.removeAttribute("data-astra-browser");
            entry.browser.setAttribute("data-astra-browser-parked", "");
          }
        } catch {
          // A browser torn down mid-switch: the next one will show.
        }
      }
    };

    // No page in front (a New Tab): every browser stays loaded but parked, so
    // coming back is instant rather than a fresh network load.
    const park = () => {
      activeId = "";
      for (const entry of browsers.values()) {
        try {
          entry.browser.removeAttribute("data-astra-browser");
          entry.browser.setAttribute("data-astra-browser-parked", "");
        } catch {
          // Torn down with the window.
        }
      }
    };

    const safeTitle = (browser) => {
      try {
        return typeof browser.contentTitle === "string" ? browser.contentTitle : "";
      } catch {
        return "";
      }
    };

    const stopWatching = (entry) => {
      if (entry.poll) {
        clearInterval(entry.poll);
        entry.poll = 0;
      }
    };

    /** Drop everything an entry owns. Called on tab close and on detach. */
    const release = (entry) => {
      stopWatching(entry);
      try {
        entry.abort?.abort();
      } catch {
        // Listeners already gone with the element.
      }
      entry.abort = null;
    };

    /** Announce load state off the current event dispatch (see `show`). */
    const markLoading = (id, loading) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (browsers.has(id)) __applyExternalUpdate(id, { loading });
      }, 0);
      timers.add(timer);
    };

    /**
     * Watch a real document load to its end. The model commits the address
     * instantly, so without this the stage is a black pane with no sign of
     * progress for as long as the network takes — the "no way to know what is
     * happening" the owner reported. A cheap poll of the browser's own load
     * flag is enough and survives remoteness changes, where an XPCOM progress
     * listener attached to the element can be dropped.
     */
    const watch = (id, entry) => {
      stopWatching(entry);
      const deadline = Date.now() + 60_000;
      let idle = 0;
      entry.poll = setInterval(() => {
        let loading = true;
        try {
          loading = entry.browser.webProgress?.isLoadingDocument === true;
        } catch {
          loading = false;
        }
        // A redirect can dip the flag for a moment between documents; two
        // quiet polls mean the load is really over.
        if (loading) {
          idle = 0;
        } else {
          idle += 1;
        }
        if (Date.now() < deadline && (loading || idle < 2)) return;
        stopWatching(entry);
        if (!browsers.has(id)) return;
        // `requested` is what this browser was asked to load, not where the
        // page itself ended up: a page that rewrites its own address must not
        // make the projection ask for the old address again, or the two fight
        // and the page reloads forever.
        __applyExternalUpdate(id, { loading: false });
        const title = safeTitle(entry.browser);
        if (title) __applyExternalUpdate(id, { title });
      }, 200);
    };

    /**
     * A content process crash leaves the `<browser>` element alive but inert:
     * its load flag never clears on its own, and because `requested` still
     * names the page the next visit would be considered "already there" and
     * skip the reload. Clear the request so the next visit loads again.
     */
    const crashed = (id, entry) => {
      stopWatching(entry);
      entry.requested = "";
      // A crashed browser still reports the address it died on, so the flag —
      // not `currentURI` — is what tells `show` this page is not "already
      // there" and has to be loaded again.
      entry.crashed = true;
      if (browsers.has(id)) __applyExternalUpdate(id, { loading: false });
    };

    const createBrowser = (id) => {
      const existing = browsers.get(id);
      if (existing) return existing;
      const browser = doc.createElementNS(XUL_NS, "browser");
      // Remote content browser: on ESR 153 a non-remote `type="content"`
      // browser created outside the tabbrowser has an inert docshell (loads
      // never commit, measured 2026-11-02). Remote is the only live path.
      browser.setAttribute("type", "content");
      browser.setAttribute("remote", "true");
      browser.setAttribute("remoteType", "web");
      browser.setAttribute("maychangeremoteness", "true");
      browser.setAttribute("flex", "1");
      // Parked until a page is in front of it.
      browser.setAttribute("data-astra-browser-parked", "");
      container.append(browser);
      const entry = { browser, requested: "", poll: 0, abort: null, crashed: false };
      browsers.set(id, entry);
      try {
        // `oop-browser-crashed` is the content-process crash signal a
        // `<browser>` element dispatches (SessionStore relies on the same
        // one); `abort` gives it back when the tab or the window goes.
        const abort = new AbortController();
        entry.abort = abort;
        browser.addEventListener("oop-browser-crashed", () => crashed(id, entry), {
          signal: abort.signal,
        });
      } catch {
        // Without AbortController the load watcher still ends the spinner.
      }
      return entry;
    };

    /** Show the selected tab's page; a tab with no page shows the New Tab, so
     *  nothing of the previous tab is left on the stage. */
    const show = (id, url, force = false) => {
      // Only a web address reaches the browser. A New Tab (empty/about:blank)
      // parks, and so does anything else: this is the one gate between the
      // model's URL and `fixupAndLoadURIString`, which loads under the system
      // principal and must never be pointed at data:/file:/javascript:.
      if (!id || !isLoadableUrl(url)) {
        if (id && typeof url === "string" && url !== "" && url !== "about:blank") {
          try {
            // Diagnostics only (no event): a refused address is worth seeing
            // in the window the same way a refused host command is.
            const win = doc.defaultView;
            if (win) {
              win.__astraLastRelayError = `content refused ${url.slice(0, 140)}`;
            }
          } catch {
            // A window without expandos: the refusal itself still stands.
          }
        }
        park();
        return;
      }
      const target = url;
      const entry = browsers.get(id) ?? createBrowser(id);
      setActive(id);
      const settled =
        !entry.crashed && (entry.requested === target || safeSpec(entry.browser) === target);
      if (settled && (!force || stillLoading(entry.browser))) {
        // Already loading it, or already showing it: a switch must not restart
        // a load the person is waiting on, and a commit for a load that is
        // still in flight is the same load, not a second one.
        return;
      }
      entry.crashed = false;
      entry.requested = target;
      // The tab row and the stage say "arriving" from the first moment, and
      // clear only when the browser's own document load ends. Deferred: this
      // call often runs inside another event's listener, and emitting there
      // would hand later listeners a lower sequence than the nested event.
      markLoading(id);
      watch(id, entry);
      try {
        entry.browser.fixupAndLoadURIString(target, { triggeringPrincipal: principal });
      } catch {
        entry.requested = "";
        stopWatching(entry);
        markLoading(id, false);
        // A tab torn down mid-switch: the next one will load.
      }
    };

    const forget = (id) => {
      const entry = browsers.get(id);
      if (!entry) return;
      release(entry);
      browsers.delete(id);
      try {
        entry.browser.remove();
      } catch {
        // Already gone with the window.
      }
      if (activeId === id) activeId = "";
    };

    let selectedId = tab.astra_tab_id;
    // The window always starts with one tab. A New Tab has no page to load,
    // so no browser is created for it; the app's New Tab fills the stage.
    show(selectedId, tab.url);

    const off = addEventListener((event) => {
      if (event.type === "tab.updated" && event.data.selected) {
        selectedId = event.data.astra_tab_id;
        show(selectedId, event.data.url);
      }
      if (event.type === "nav.committed" && event.data.astra_tab_id === selectedId) {
        // A commit is an explicit navigation intent (typed address, back,
        // forward, reload), so it loads even when the browser is already on
        // that address. An external commit (the page itself landing on it)
        // is not an intent and must not cause another load.
        const intent = event.data.external !== true;
        show(selectedId, event.data.url, intent);
      }
      if (event.type === "tab.closed") {
        forget(event.data.astra_tab_id);
      }
      // The projection is the authority on what is in front: a tab switch, a
      // closed tab or a New Tab all land here, and the right page comes up.
      if (event.type === "items-changed") {
        // Only the active space's tabs are in this projection; a page kept
        // for another space is still live, so pages are forgotten on
        // `tab.closed` (above), never because they are out of view here.
        const tabs = event.data?.tabs ?? [];
        const active = tabs.find((entry) => entry.id === event.data?.active);
        if (active) {
          selectedId = active.id;
          show(active.id, active.url);
        } else {
          // Nothing to put in front: an empty space, or the last tab closed.
          // The stage belongs to the app's New Tab, so the page kept for the
          // space we came from must not stay visible underneath it.
          selectedId = "";
          park();
        }
      }
    });

    return {
      get browser() {
        return activeBrowser();
      },
      browsers,
      detach() {
        off();
        for (const timer of timers) {
          clearTimeout(timer);
        }
        timers.clear();
        for (const entry of browsers.values()) {
          release(entry);
          try {
            entry.browser.remove();
          } catch {
            // Window teardown: already gone.
          }
        }
        browsers.clear();
        activeId = "";
        selectedId = "";
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

  // Element hiding (P4-T11 live wiring). The Content actor owns the
  // ContentHide protocol module: rule state and the picking flow live
  // here; the content script (frame script / process script in the live
  // shell) is a thin `installLiveHiding` driver over the page document.
  ContentHide,

  // Wire the real providers into ContentHide's injectable seams. Pass the
  // shell's privileged native lookups; both are optional and degrade to
  // the in-memory defaults when absent (contract tests, standalone):
  //   - `cosmeticSelectors(url, classes, ids)`: sync array return, e.g.
  //     the `astra-blocker` `cosmetic_selectors` engine call.
  //   - `overrideSet(host, action)` / `overrideGet(host)`: the
  //     `blocker_override_set`-shaped store writer (plus an optional
  //     reader for when a native read path lands).
  wireHiding({ cosmeticSelectors = null, overrideSet = null, overrideGet = null } = {}) {
    if (typeof cosmeticSelectors === "function") {
      setCosmeticProvider(createBlockerCosmeticProvider(cosmeticSelectors));
    }
    if (typeof overrideSet === "function" || typeof overrideGet === "function") {
      setStoreAdapter(
        createOverrideStoreAdapter({ setAction: overrideSet, getActions: overrideGet }),
      );
    }
    return true;
  },

  // Attach live hiding to a page document: initial pass + stylesheet +
  // MutationObserver re-pass. Returns the `installLiveHiding` handle
  // (`{ selectors, hidden, detach, run }`).
  attachHiding(doc, opts = {}) {
    return installLiveHiding(doc, opts);
  },
};

function safeSpec(browser) {
  try {
    return browser.currentURI ? browser.currentURI.spec : "";
  } catch {
    return "";
  }
}

function stillLoading(browser) {
  try {
    return browser.webProgress ? browser.webProgress.isLoadingDocument === true : false;
  } catch {
    return false;
  }
}


export { __applyExternalUpdate };
