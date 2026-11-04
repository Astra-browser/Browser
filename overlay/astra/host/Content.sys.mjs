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

import { addEventListener, emit } from "./Events.sys.mjs";
import {
  Tabs,
  __adoptNative,
  __announceAdopted,
  __applyExternalUpdate,
  __markPrivate,
  __spaceUserContextId,
  __tabsState,
} from "./Tabs.sys.mjs";
import { Navigation, __commitExternal } from "./Navigation.sys.mjs";
import { Favicons, __setFaviconEventSink } from "./Favicons.sys.mjs";
import { Media } from "./Media.sys.mjs";
import { DialogPrompts } from "./DialogPrompts.sys.mjs";
import { releaseSpaceContext, userContextForSpace } from "./Containers.sys.mjs";
import {
  ContentHide,
  createBlockerCosmeticProvider,
  createOverrideStoreAdapter,
  installLiveHiding,
  setCosmeticProvider,
  setStoreAdapter,
} from "./ContentHide.sys.mjs";

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

export function loadWatchStep({
  loading,
  seenLoading,
  currentUrl,
  requestedUrl,
  previousUrl,
  elapsedMs,
  startDeadlineMs,
}) {
  // A fast local page can finish before the first 200 ms poll. The document is
  // already on the requested URL (or has redirected off the previous one), so
  // treat that as "started and finished", not "the request never started".
  const committed =
    !loading &&
    typeof currentUrl === "string" &&
    currentUrl !== "" &&
    currentUrl !== "about:blank" &&
    (currentUrl === requestedUrl || currentUrl !== previousUrl);
  const observed = seenLoading === true || loading === true || committed;
  const live = loading === true || (!observed && elapsedMs < startDeadlineMs);
  return { live, seenLoading: observed, fastDone: committed && !loading };
}

/**
 * Gecko state for one content browser: a tab in front renders and keeps its
 * layer, a parked tab gives both back.
 *
 * `docShellIsActive = false` is what actually parks a page (ESR 153):
 * `BrowsingContext::IsActive()` goes false, the outer window becomes
 * background, so `document.visibilityState` turns `hidden`, the refresh driver
 * stops (no rAF) and the remote tab stops rendering. The page is NOT unloaded:
 * its document, scroll position and JS heap stay, so selecting it again is a
 * layer switch, not a load.
 *
 * `preserveLayers` is deliberately false while parked. Firefox's tabbrowser
 * keeps it true for a small warm layer cache (`deactivateCachedBackgroundTabs`)
 * and pays the memory for it; the point of parking here is to give that memory
 * back. It is a no-op on a non-remote browser, and every Astra page browser is
 * remote.
 *
 * Media is intentionally not an input. ESR 153 suspends a hidden page's media
 * only when the top browsing context opts in through
 * `suspendMediaWhenInactive` (`HTMLMediaElement::ShouldBeSuspendedByInactiveDocShell`);
 * the field defaults to false and `applyActivation` keeps it false, so a
 * parked tab keeps playing audio/video. If that ever stops holding, the narrow
 * exception is to keep the docshell active while
 * `browsingContext.mediaController.isPlaying === true` and re-park the tab on
 * the browser's `DOMAudioPlaybackStopped` event.
 */
export function docshellState(isActive) {
  const active = isActive === true;
  // Activation sets the docshell active first, then clears preserve (the
  // tabbrowser's wake order). Parking clears preserve first, so the layer can
  // actually be released before the docshell goes inactive.
  return { docShellIsActive: active, preserveLayers: false };
}

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

/**
 * True for a private browsing window. The browser chrome marks its root
 * element when it is private; `PrivateBrowsingUtils` is the module API, but a
 * lazily-imported module cannot answer synchronously from `createBrowser`.
 * Reading the attribute is what tabbrowser itself does
 * (`docElement.getAttribute("privatebrowsingmode") == "temporary"`).
 */
export function isPrivateWindow(win) {
  try {
    if (win && win.PrivateBrowsingUtils?.isWindowPrivate?.(win)) {
      return true;
    }
  } catch {
    // Fall through to the document marker.
  }
  try {
    return (
      win?.document?.documentElement?.getAttribute("privatebrowsingmode") ===
      "temporary"
    );
  } catch {
    return false;
  }
}

/**
 * Let Places record visits for this content browser. A remote `<browser>`
 * inherits `useGlobalHistory` from the chrome window's browsing context, which
 * is false here, so every page load was silently dropped from history. The
 * content browsing context owns the visits, so the flag belongs on it — and
 * only for non-private windows: a private window's parent context already
 * suppresses history, and forcing the flag on would record what must not be
 * recorded.
 */
export function allowGlobalHistory(browser) {
  try {
    const win = browser?.ownerDocument?.defaultView;
    if (isPrivateWindow(win)) {
      return false;
    }
    const context = browser.browsingContext;
    if (context) {
      context.useGlobalHistory = true;
    }
    return true;
  } catch {
    // A browser torn down mid-switch: the next one will take the flag.
    return false;
  }
}

// Progress-listener factory: pure over (tabIdOf, commit, setTitle) so Node
// contract tests can drive it with fakes and the live binding passes the
// real tabbrowser mapping. `tabIdOf(browser)` maps a `<browser>` element
// to its `astra_tab_id` (null when untracked).
const ERROR_PAGE_FLAG =
  typeof Ci !== "undefined" ? Ci.nsIWebProgressListener.LOCATION_CHANGE_ERROR_PAGE : 0x2;

export function makeProgressListener({ tabIdOf, commit = __commitExternal, setTitle, onErrorPage } = {}) {
  const resolveTitle = setTitle ?? ((id, title) => Tabs.setTitle({ astra_tab_id: id, title }));
  return {
    onLocationChange(browser, progress, _request, location, flags) {
      try {
        // Subframe navigations are not the tab's address; committing them
        // would rewrite the model URL/history on every ad or embed iframe.
        if (progress && progress.isTopLevel === false) {
          return;
        }
        const id = tabIdOf ? tabIdOf(browser) : null;
        const url = location && location.spec ? location.spec : "";
        // A refused certificate is an error page: the engine docshell reports
        // the failed URI with this flag. Let the normal commit record the
        // attempted address; the certificate path raises the failure pane if
        // (and only if) the channel really is a TLS error.
        if ((Number(flags) & ERROR_PAGE_FLAG) !== 0 && id && typeof onErrorPage === "function") {
          onErrorPage({ astra_tab_id: id, url, browser });
        }
        if (id && url) {
          // Tell the model whether the browser is still fetching, so the
          // stage's skeleton and the row's spinner survive an early commit.
          commit(id, url, { loading: stillLoading(browser) });
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

function browserWindow(browser) {
  try {
    return browser?.ownerDocument?.defaultView ?? null;
  } catch {
    return null;
  }
}

/** Live zoom for one browser. Returns false when no ZoomManager is reachable. */
export function applyZoomToBrowser(browser, zoom) {
  try {
    const win = browserWindow(browser);
    const ZoomManager = win?.ZoomManager;
    if (!ZoomManager || typeof zoom !== "number" || !Number.isFinite(zoom)) {
      return false;
    }
    ZoomManager.setZoomForBrowser(browser, zoom);
    return true;
  } catch {
    return false;
  }
}

/** Live print for one browser. Returns false when PrintUtils is unreachable. */
export function printBrowser(browser) {
  try {
    const win = browserWindow(browser);
    const PrintUtils = win?.PrintUtils;
    if (!PrintUtils || typeof PrintUtils.startPrintWindow !== "function") {
      return false;
    }
    PrintUtils.startPrintWindow(browser.browsingContext, { printToFile: false });
    return true;
  } catch {
    return false;
  }
}

/** Stop one browser's in-flight load. */
export function stopBrowser(browser) {
  try {
    if (browser && typeof browser.stop === "function") {
      browser.stop();
      return true;
    }
  } catch {
    // Browser torn down mid-load.
  }
  return false;
}

/** Reload one browser, bypassing both the HTTP cache and any proxy cache. */
export function hardReloadBrowser(browser) {
  try {
    const win = browserWindow(browser);
    const nav = win?.Ci?.nsIWebNavigation;
    if (!browser || typeof browser.reloadWithFlags !== "function" || !nav) {
      return false;
    }
    const flags = nav.LOAD_FLAGS_BYPASS_PROXY | nav.LOAD_FLAGS_BYPASS_CACHE;
    if (!flags) {
      return false;
    }
    browser.reloadWithFlags(flags);
    return true;
  } catch {
    // Browser torn down mid-reload.
  }
  return false;
}

export const Content = {
  // Mounts the content browsers into `container` (an element in the chrome
  // document) and ensures exactly one live tab exists. One `<browser>` is
  // kept per page tab: switching tabs then shows the page that was already
  // there instead of reloading it from the network, which is what made a
  // switch back look like a dead black stage for the length of a page load.
  // Returns `{ browser, browsers, detach }`. Safe to call once per window.
  /**
   * P4.2: map the Astra tab model onto native gBrowser tabs. The native tab
   * strip stays hidden; the shell docks #tabbrowser-tabbox over the stage.
   * This mount owns the id <-> native tab map and translates host events;
   * Navigation/zoom/stop/print still go through the same event intents.
   */
  async mountNative(container, { request_id = "content-native", window_id = "" } = {}) {
    const win = container?.ownerDocument?.defaultView ?? null;
    const gb = win?.gBrowser;
    if (!gb || typeof gb.addTab !== "function") {
      throw new Error("mountNative: gBrowser unavailable");
    }
    const doc = container.ownerDocument;
    const principal = systemPrincipalOf(container);
    const tabOf = new Map(); // astra_tab_id -> native tab
    const idOf = new WeakMap(); // native tab -> astra_tab_id
    const browsers = new Map(); // astra_tab_id -> { browser, tab }
    const pending = new Map(); // astra_tab_id -> URL to load on first activation
    __setFaviconEventSink((view) => emit("favicons-changed", view));
    let applying = false;

    const idOfTab = (tab) => {
      if (!tab) return "";
      return idOf.get(tab) || tab.getAttribute("astra-tab-id") || "";
    };
    const bindTab = (id, tab) => {
      if (!id || !tab) return;
      tab.setAttribute("astra-tab-id", id);
      // P5b: the organisation store must never keep a private tab. Content is
      // the only layer that knows the window, so it stamps the record here.
      __markPrivate(id, isPrivateWindow(win));
      tabOf.set(id, tab);
      idOf.set(tab, id);
      const browser = tab.linkedBrowser ?? null;
      if (browser) {
        browsers.set(id, { browser, tab });
        attachMedia(id, browser);
        // A remote browser inherits the chrome window's false
        // useGlobalHistory; the native tab needs the same fix as mount().
        allowGlobalHistory(browser);
        // A restored native tab already has its committed URL/title.
        try {
          const spec = browser.currentURI?.spec;
          if (spec && spec !== "about:blank") {
            __applyExternalUpdate(id, { url: spec });
          }
          const title = browser.contentTitle;
          if (typeof title === "string" && title !== "") {
            __applyExternalUpdate(id, { title });
          }
        } catch {
          // A tab that is still restoring.
        }
      }
    };
    // --- media player projection (P9) -----------------------------------
    // The sidebar player belongs to the tab playing behind the page in front.
    // The engine controller lives per browser; a private window projects
    // nothing. Position/duration arrive only when the page publishes them.
    const mediaStates = new Map(); // astra_tab_id -> state
    const mediaView = (id) => {
      const state = mediaStates.get(id);
      if (!state) return null;
      const controller = state.controller;
      let active = false;
      try {
        active = controller.isActive === true;
      } catch {
        active = false;
      }
      if (!active) return null;
      let metadata = null;
      try {
        metadata = controller.getMetadata?.() ?? null;
      } catch {
        metadata = null;
      }
      const tab = tabOf.get(id);
      const title = String(metadata?.title || tab?.label || state.browser.contentTitle || "").trim();
      if (title === "") return null;
      let site = "";
      try {
        site = state.browser.currentURI?.host ?? "";
      } catch {
        site = "";
      }
      return {
        tab_id: id,
        title,
        artist: String(metadata?.artist || site || ""),
        icon: null,
        duration: state.duration ?? null,
        position: state.position ?? null,
        rate: state.rate ?? null,
        playing: controller.isPlaying === true,
        waiting: false,
        can_pip: false,
        in_pip: false,
        muted: state.browser.audioMuted === true,
        can_mute: true,
      };
    };
    const projectMedia = (id) => {
      const selected = (() => {
        try {
          return __tabsState().selectedId;
        } catch {
          return "";
        }
      })();
      if (isPrivateWindow(win) || id === selected) {
        Media.__projectMedia(id, null);
        return;
      }
      Media.__projectMedia(id, mediaView(id));
    };
    const detachMedia = (id) => {
      const state = mediaStates.get(id);
      if (state) {
        for (const [type, fn] of state.listeners) {
          try {
            state.controller.removeEventListener(type, fn);
          } catch {
            // The browser went away with the controller.
          }
        }
        mediaStates.delete(id);
      }
      Media.__projectMedia(id, null);
    };
    const attachMedia = (id, browser) => {
      detachMedia(id);
      if (!browser || isPrivateWindow(win)) return;
      let controller = null;
      try {
        controller = browser.browsingContext?.mediaController ?? null;
      } catch {
        controller = null;
      }
      if (!controller || typeof controller.addEventListener !== "function") return;
      const state = {
        browser,
        controller,
        position: null,
        duration: null,
        rate: null,
        listeners: [],
      };
      const refresh = () => projectMedia(id);
      for (const type of [
        "activated",
        "deactivated",
        "playbackstatechange",
        "metadatachange",
        "supportedkeyschange",
        "audiblechange",
      ]) {
        const fn = () => refresh();
        try {
          controller.addEventListener(type, fn);
          state.listeners.push([type, fn]);
        } catch {
          // A controller without that event.
        }
      }
      const onPosition = (event) => {
        state.position = Number.isFinite(event.position) ? event.position : null;
        state.duration = Number.isFinite(event.duration) ? event.duration : null;
        state.rate = Number.isFinite(event.playbackRate) ? event.playbackRate : null;
        refresh();
      };
      try {
        controller.addEventListener("positionstatechange", onPosition);
        state.listeners.push(["positionstatechange", onPosition]);
      } catch {
        // No position state on this engine.
      }
      mediaStates.set(id, state);
      refresh();
    };
    Media.__setEngine({
      dispatch: (id, action) => {
        const state = mediaStates.get(id);
        const controller = state?.controller ?? null;
        switch (action.kind) {
          case "play":
            if (!controller) return false;
            try {
              controller.play();
            } catch {
              return false;
            }
            projectMedia(id);
            return true;
          case "pause":
            if (!controller) return false;
            try {
              controller.pause();
            } catch {
              return false;
            }
            projectMedia(id);
            return true;
          case "seek":
            if (!controller || !Number.isFinite(action.seconds)) return false;
            try {
              controller.seekTo(action.seconds, false);
            } catch {
              return false;
            }
            projectMedia(id);
            return true;
          case "show":
            void Tabs.select({ request_id: `media-show-${id}`, astra_tab_id: id });
            return true;
          case "close":
            Media.__projectMedia(id, null);
            return true;
          default:
            return false;
        }
      },
    });
    const refreshIcon = (id) => {
      const tab = tabOf.get(id);
      const browser = tab?.linkedBrowser;
      const url = browser?.currentURI?.spec;
      if (!isLoadableUrl(url) || isPrivateWindow(win)) return;
      void Favicons.resolve({ url, doc })
        .then((resolved) => {
          if (!resolved) return;
          __applyExternalUpdate(id, {
            icon: {
              origin: resolved.entry.origin,
              revision: resolved.entry.revision,
            },
          });
          Favicons.publish(resolved);
        })
        .catch(() => {
          // A broken icon never blocks the page.
        });
    };
    const forgetTab = (id) => {
      const tab = tabOf.get(id);
      if (tab) {
        idOf.delete(tab);
        tab.removeAttribute("astra-tab-id");
      }
      detachMedia(id);
      tabOf.delete(id);
      browsers.delete(id);
      pending.delete(id);
    };
    const contextFor = (id) => {
      try {
        const tab = __tabsState().tabs.get(id);
        if (tab && !isPrivateWindow(win)) {
          return userContextForSpace(tab.space_id);
        }
      } catch {
        // A tab without a record keeps the default context.
      }
      return 0;
    };
    const ensureTab = (id, url) => {
      let tab = tabOf.get(id);
      if (tab) return tab;
      applying = true;
      try {
        // Reuse the tabbrowser's initial about:blank tab instead of leaving
        // an unbound tab beside the model's first tab.
        const wanted = contextFor(id);
        const free = [...gb.tabs].find((candidate) => {
          if (idOfTab(candidate)) return false;
          try {
            const spec = candidate.linkedBrowser?.currentURI?.spec;
            const context = Number(candidate.getAttribute("usercontextid") || 0);
            const blank = !spec || spec === "about:blank" ||
              spec.startsWith("chrome://browser/content/blanktab");
            return blank && context === wanted;
          } catch {
            return false;
          }
        });
        if (free) {
          tab = free;
          bindTab(id, tab);
          if (isLoadableUrl(url)) pending.set(id, url);
          return tab;
        }
        tab = gb.addTab("about:blank", {
          triggeringPrincipal: principal,
          inBackground: true,
          userContextId: wanted,
        });
        bindTab(id, tab);
        if (isLoadableUrl(url)) pending.set(id, url);
      } finally {
        applying = false;
      }
      return tab;
    };
    const loadIn = (id, url, force = false) => {
      const tab = tabOf.get(id);
      if (!tab || !isLoadableUrl(url)) return;
      const browser = tab.linkedBrowser;
      try {
        allowGlobalHistory(browser);
        if (!force && browser?.currentURI?.spec === url) return;
        browser?.fixupAndLoadURIString(url, { triggeringPrincipal: principal });
      } catch {
        // A tab torn down mid-load.
      }
    };
    const selectTab = (id) => {
      const tab = tabOf.get(id);
      if (!tab || gb.selectedTab === tab) return;
      applying = true;
      try {
        gb.selectedTab = tab;
      } finally {
        applying = false;
      }
    };
    const activate = (id) => {
      const url = pending.get(id);
      if (!url && gb.selectedTab === tabOf.get(id)) {
        return;
      }
      selectTab(id);
      if (url) {
        pending.delete(id);
        loadIn(id, url, true);
      }
    };

    // Adopt the tabbrowser's initial tab for the first model tab, then add
    // one native tab per model tab. The model is bootstrapped before mount.
    const belongs = (id) => {
      if (!window_id || !id) return true;
      const tab = __tabsState().tabs.get(id);
      return !tab || tab.window_id === window_id;
    };
    const list = await Tabs.list({ request_id, window_id });
    const modelTabs = list.tabs ?? [];
    for (const model of modelTabs) {
      ensureTab(model.astra_tab_id, model.url);
      if (model.url && model.url !== "about:blank") {
        pending.set(model.astra_tab_id, model.url);
      }
      if (model.selected) {
        activate(model.astra_tab_id);
      }
    }
    const selected = modelTabs.find((t) => t.selected) ?? modelTabs[0];
    if (selected) activate(selected.astra_tab_id);

    // Native -> model: selection, close and the end of a document load
    // (`busy` clears when the native browser has finished). The progress
    // listener keeps the title/URL side; this keeps the loading flag honest.
    const onAttr = (event) => {
      const tab = event.target;
      const id = idOfTab(tab);
      if (!id) return;
      const changed = event.detail?.changed ?? [];
      if (changed.includes("busy") && !tab.hasAttribute("busy")) {
        __applyExternalUpdate(id, { loading: false });
        refreshIcon(id);
      }
    };
    gb.tabContainer.addEventListener("TabAttrModified", onAttr);
    const onSelect = () => {
      if (applying) return;
      const id = idOfTab(gb.selectedTab);
      if (id) {
        void Tabs.select({ astra_tab_id: id });
      } else {
        // An engine-created tab is in front. P4.3 adopts it; until then put
        // the model's tab back rather than showing a page the model lost.
        const selected = __tabsState().selectedId;
        if (selected) activate(selected);
      }
      // The player follows the tab behind the page in front.
      for (const id of [...mediaStates.keys()]) projectMedia(id);
    };
    const onClose = (event) => {
      if (applying) return;
      const id = idOfTab(event.target);
      if (id) void Tabs.close({ astra_tab_id: id });
    };
    const onOpen = (event) => {
      if (applying) return;
      const tab = event.target;
      if (!tab || idOfTab(tab)) return;
      let url = "about:blank";
      try {
        url = tab.linkedBrowser?.currentURI?.spec || url;
      } catch {
        // A tab that has not committed yet is a New Tab.
      }
      const id = __adoptNative({
        url,
        selected: tab.selected === true,
        window_id: window_id || "win-1",
      });
      bindTab(id, tab);
      __announceAdopted(id, { selected: tab.selected === true });
    };
    const progress = makeProgressListener({
      tabIdOf: (browser) => idOfTab(gb.getTabForBrowser(browser)),
      onErrorPage: ({ astra_tab_id, url, browser }) => {
        void DialogPrompts.certErrorFor({ browser, failedURI: url, tabId: astra_tab_id });
      },
    });
    gb.addTabsProgressListener(progress);
    gb.tabContainer.addEventListener("TabSelect", onSelect);
    gb.tabContainer.addEventListener("TabClose", onClose);
    gb.tabContainer.addEventListener("TabOpen", onOpen);

    const off = addEventListener((event) => {
      const id = event.data?.astra_tab_id;
      if (event.data?.window_id && window_id && event.data.window_id !== window_id) {
        return;
      }
      if (id && !belongs(id)) {
        return;
      }
      if (event.type === "tab.created" && id) {
        ensureTab(id, event.data.url);
        return;
      }
      if (event.type === "tab.closed" && id) {
        const tab = tabOf.get(id);
        forgetTab(id);
        if (tab) {
          applying = true;
          try {
            if (gb.tabs.length <= 1) {
              gb.addTab("about:blank", {
                triggeringPrincipal: principal,
                inBackground: true,
              });
            }
            if (!tab.closing) {
              gb.removeTab(tab, { skipPermitUnload: true, closeWindowWithLastTab: false });
            }
          } catch {
            // Already gone with the window.
          } finally {
            applying = false;
          }
        }
        return;
      }
      if (event.type === "items-changed") {
        const active = (event.data?.tabs ?? []).find((t) => t.id === event.data?.active);
        if (active && !belongs(active.id)) {
          return;
        }
        if (active && active.id) {
          ensureTab(active.id, active.url);
          activate(active.id);
        }
        return;
      }
      if ((event.type === "tab.pinned" || event.type === "tab.unpinned") && id) {
        const tab = tabOf.get(id);
        try {
          if (event.type === "tab.pinned") {
            gb.pinTab(tab);
          } else {
            gb.unpinTab(tab);
          }
        } catch {
          // A closing tab keeps the model state.
        }
        return;
      }
      if (event.type === "tab.discarded" && id) {
        const tab = tabOf.get(id);
        if (tab && !tab.hasAttribute("discarded")) {
          let discarded = false;
          try {
            discarded = gb.discardBrowser(tab, true) === true;
          } catch {
            discarded = false;
          }
          if (!discarded) {
            __applyExternalUpdate(id, { discarded: false });
          }
        }
        return;
      }
      if (event.type === "tab.restored" && id) {
        const tab = tabOf.get(id);
        if (tab?.hasAttribute("discarded")) {
          // `reloadTab` restores the lazy state saved by discardBrowser and
          // clears the native `discarded` attribute.
          try {
            gb.reloadTab(tab);
          } catch {
            // The next activation restores it.
          }
          const url = __tabsState().tabs.get(id)?.url;
          if (url) {
            loadIn(id, url, true);
          }
        }
        return;
      }
      if (event.type === "space.deleted" && event.data?.space) {
        releaseSpaceContext(event.data.space);
        return;
      }
      if (event.type === "tab.space-changed" && id) {
        const old = tabOf.get(id);
        let url = __tabsState().tabs.get(id)?.url || "about:blank";
        try {
          url = old?.linkedBrowser?.currentURI?.spec || url;
        } catch {
          // Keep the model URL.
        }
        if (old) {
          applying = true;
          try {
            if (!old.closing) {
              gb.removeTab(old, { skipPermitUnload: true, closeWindowWithLastTab: false });
            }
          } catch {
            // Already gone.
          } finally {
            applying = false;
          }
        }
        forgetTab(id);
        ensureTab(id, url);
        if (__tabsState().tabs.get(id)?.selected) {
          activate(id);
        }
        return;
      }
      if (event.type === "tab.updated" && id) {
        if (event.data.selected) {
          activate(id);
        }
        if ("muted" in event.data) {
          const tab = tabOf.get(id);
          const want = event.data.muted === true;
          try {
            if (tab && tab.linkedBrowser?.audioMuted !== want) {
              tab.toggleMuteAudio();
            }
          } catch {
            // A tab torn down mid-toggle.
          }
          projectMedia(id);
        }
        return;
      }
      if (event.type === "nav.committed" && id && event.data.external !== true) {
        pending.delete(id);
        loadIn(id, event.data.url, true);
        refreshIcon(id);
        return;
      }
      if (event.type === "nav.hard-reload" && id) {
        const tab = tabOf.get(id);
        try {
          const Ci = win.Ci;
          tab?.linkedBrowser?.reloadWithFlags(
            Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_PROXY |
              Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE,
          );
        } catch {}
        return;
      }
      if (event.type === "page.request-answered" && id) {
        // "Reload" on a page that stopped responding; the other kinds are
        // opened by the caller that raised them.
        if (event.data?.kind === "unresponsive" && event.data?.answer !== "dismiss") {
          try {
            tabOf.get(id)?.linkedBrowser?.reload();
          } catch {}
        }
        return;
      }
      if (event.type === "nav.stopped" && id) {
        try { tabOf.get(id)?.linkedBrowser?.stop(); } catch {}
        return;
      }
      if (event.type === "nav.zoom-changed" && id) {
        applyZoomToBrowser(tabOf.get(id)?.linkedBrowser, event.data?.zoom);
        return;
      }
      if (event.type === "nav.print-requested" && id) {
        printBrowser(tabOf.get(id)?.linkedBrowser);
      }
    });

    // Reconcile after the await/listener gap: a tab created or navigated
    // while mountNative was awaiting must still get its native tab/URL.
    const fresh = await Tabs.list({ request_id, window_id });
    for (const model of fresh.tabs ?? []) {
      const tab = ensureTab(model.astra_tab_id, model.url);
      const spec = tab?.linkedBrowser?.currentURI?.spec;
      if (
        model.url && model.url !== "about:blank" &&
        spec !== model.url && !pending.has(model.astra_tab_id)
      ) {
        pending.set(model.astra_tab_id, model.url);
      }
      if (model.selected) {
        activate(model.astra_tab_id);
      }
    }

    // Adopt native tabs SessionStore restored before this mount. They are
    // already loaded; bind them to model tabs without reloading the page.
    for (const tab of [...gb.tabs]) {
      if (idOfTab(tab)) continue;
      let url = "about:blank";
      let title = "";
      try {
        url = tab.linkedBrowser?.currentURI?.spec || url;
        title = tab.linkedBrowser?.contentTitle || "";
      } catch {
        // A tab that is still restoring.
      }
      const id = __adoptNative({
        url,
        selected: tab.selected === true,
        window_id: window_id || "win-1",
      });
      bindTab(id, tab);
      if (title) __applyExternalUpdate(id, { title });
      __announceAdopted(id, { selected: tab.selected === true });
    }

    // A restored session arrives beside the shell's bootstrap New Tab. Drop
    // the blank bootstrap row so the restored tabs are the session, and put
    // one of them in front.
    try {
      const now = await Tabs.list({ request_id, window_id });
      const rows = now.tabs ?? [];
      const blank = rows.find((t) => !t.url || t.url === "about:blank");
      const restored = rows.filter((t) => t.url && t.url !== "about:blank");
      if (blank && restored.length > 0) {
        const chosen = restored.find((t) => t.selected) ?? restored[0];
        await Tabs.close({ astra_tab_id: blank.astra_tab_id });
        await Tabs.select({ astra_tab_id: chosen.astra_tab_id });
      }
    } catch {
      // Restore is best-effort; never block a working window.
    }

    return {
      native: true,
      get browser() {
        return gb.selectedBrowser ?? null;
      },
      browsers,
      detach() {
        off();
        Media.__setEngine(null);
        for (const id of [...mediaStates.keys()]) detachMedia(id);
        try { gb.tabContainer.removeEventListener("TabSelect", onSelect); } catch {}
        try { gb.tabContainer.removeEventListener("TabClose", onClose); } catch {}
        try { gb.tabContainer.removeEventListener("TabOpen", onOpen); } catch {}
        try { gb.tabContainer.removeEventListener("TabAttrModified", onAttr); } catch {}
        try { gb.removeTabsProgressListener(progress); } catch {}
        for (const id of [...tabOf.keys()]) forgetTab(id);
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
    return applyZoomToBrowser(browser, zoom);
  },

  // Live print dispatch for Navigation.print intent. Best-effort: resolves
  // false when PrintUtils is unreachable (model event already emitted).
  printPage(browser) {
    return printBrowser(browser);
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
