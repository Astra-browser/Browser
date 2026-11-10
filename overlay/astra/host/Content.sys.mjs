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
  DEFAULT_WINDOW_ID,
  Tabs,
  __adoptNative,
  __announceAdopted,
  __applyExternalUpdate,
  __forgetWindow,
  __startArchiveScheduler,
  __markPrivate,
  __setTabGroup,
  __spaceUserContextId,
  __tabsState,
  emitItemsChanged,
} from "./Tabs.sys.mjs";
import { Navigation, __commitExternal } from "./Navigation.sys.mjs";
import { setDriver as setTabHistoryDriver } from "./TabHistory.sys.mjs";
import { Favicons, __setFaviconEventSink } from "./Favicons.sys.mjs";
import { Media } from "./Media.sys.mjs";
import { chooseMedia } from "./MediaSelection.sys.mjs";
import { Blocker } from "./Blocker.sys.mjs";
import { __bindSplitWindow, __unbindSplitWindow } from "./SplitView.sys.mjs";
import { __flushSpaceHistory, noteTabVisit } from "./SpaceHistory.sys.mjs";
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
 * Media is not an input by itself. ESR 153 suspends a hidden page's media only
 * when the top browsing context opts in through `suspendMediaWhenInactive`
 * (`HTMLMediaElement::ShouldBeSuspendedByInactiveDocShell`); the field
 * defaults to false and `applyActivation` keeps it false, so a parked tab keeps
 * playing audio/video. The exception is the source of a media PiP player:
 * `applyTabActivation` keeps that browser active so the player's clone keeps
 * receiving frames, and re-parks it when the engine clears the tab marker.
 */
export function docshellState(isActive) {
  const active = isActive === true;
  // Activation sets the docshell active first, then clears preserve (the
  // tabbrowser's wake order). Parking clears preserve first, so the layer can
  // actually be released before the docshell goes inactive.
  return { docShellIsActive: active, preserveLayers: false };
}

/**
 * Apply the docshell state to one live `<browser>`. This is the step that
 * makes a tab switch real to the page: the outgoing document goes
 * `visibilityState = "hidden"`, which is what the engine's automatic
 * picture-in-picture watches (`VideoTabHidden`). Merely hiding the tabbox
 * leaves both documents visible and the video never becomes eligible.
 *
 * `preserveLayers` is always false: parking exists to give the layer back.
 * Exported so the contract test can pin the write order without a build.
 */
export function applyBrowserActivation(browser, isActive) {
  if (!browser) return false;
  const state = docshellState(isActive);
  try {
    browser.docShellIsActive = state.docShellIsActive;
    if (typeof browser.preserveLayers === "function") {
      browser.preserveLayers(state.preserveLayers);
    }
    return true;
  } catch {
    // A browser torn down mid-switch.
    return false;
  }
}

/**
 * True when the browser is the source of a media Picture-in-Picture player.
 * Gecko sets the native tab's `pictureinpicture` attribute when a clone opens
 * and clears it when the player closes; while it is set the engine keeps the
 * source docshell active so the clone receives frames. Parking it would stop
 * that clone and make the page fire `VideoTabHidden` again, which auto-PiP
 * reads as a second toggle and closes the player.
 */
export function isPictureInPictureSource(entry) {
  const tab = entry && typeof entry === "object" ? entry.tab : null;
  try {
    return (
      tab?.pictureinpicture === true ||
      tab?.hasAttribute?.("pictureinpicture") === true
    );
  } catch {
    return false;
  }
}

/** Activate every browser in `active` and park every other entry. */
export function applyTabActivation(browsers, active) {
  if (!browsers) return 0;
  const activeIds =
    active instanceof Set
      ? active
      : new Set(Array.isArray(active) ? active : [active]);
  const entries =
    browsers instanceof Map ? browsers.entries() : Object.entries(browsers);
  let applied = 0;
  for (const [id, entry] of entries) {
    const browser =
      entry && typeof entry === "object" && "browser" in entry ? entry.browser : entry;
    const keep = activeIds.has(id) || isPictureInPictureSource(entry);
    if (applyBrowserActivation(browser, keep)) applied += 1;
  }
  return applied;
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
const STATE_STOP_FLAG =
  typeof Ci !== "undefined" ? Ci.nsIWebProgressListener.STATE_STOP : 0x10;

export function makeProgressListener({
  tabIdOf,
  commit = __commitExternal,
  setTitle,
  onErrorPage,
  onCommit,
  onStop,
} = {}) {
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
          if (typeof onCommit === "function") {
            onCommit(id, url, browser);
          }
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
    onStateChange(browser, progress, _request, stateFlags) {
      try {
        const stopFlag = STATE_STOP_FLAG;
        if ((Number(stateFlags) & stopFlag) === 0) return;
        if (progress && progress.isTopLevel === false) return;
        const id = tabIdOf ? tabIdOf(browser) : null;
        if (id && typeof onStop === "function") onStop(id, browser);
      } catch {
        // A torn-down listener must not break the browser.
      }
    },
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

// Windows with a live content mount, so TabHistory can find the native tab
// behind an Astra id. The module itself stays pure: the driver below is the
// only place that reads the engine. One entry per window; mountNative adds it
// and detach removes it, so a closed window leaves no tab behind.
const historyWindows = new Map(); // window -> Map(astra_tab_id -> native tab)

/** The engine's own session history for one native tab, or null. Never throws. */
function sessionHistoryOf(win, tab) {
  try {
    const history = win?.SessionStore?.getSessionHistory?.(tab);
    if (!history || !Array.isArray(history.entries)) return null;
    return {
      index: Number.isInteger(history.index) ? history.index : history.entries.length - 1,
      entries: history.entries.map((entry) => ({
        url: typeof entry?.url === "string" ? entry.url : "",
        // Entries the engine kept without a title still have an address, and
        // that is the only label the menu can show for them.
        title:
          typeof entry?.title === "string" && entry.title !== ""
            ? entry.title
            : typeof entry?.url === "string"
              ? entry.url
              : "",
      })),
    };
  } catch {
    return null;
  }
}

function listTabHistory(astra_tab_id) {
  for (const [win, tabs] of historyWindows) {
    const tab = tabs.get(astra_tab_id);
    if (!tab) continue;
    return sessionHistoryOf(win, tab);
  }
  return null;
}

/** Point TabHistory at the live windows, or clear it when none is mounted. */
function refreshTabHistoryDriver() {
  setTabHistoryDriver(historyWindows.size === 0 ? null : { list: listTabHistory });
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
    // The live cosmetic provider is the native engine. The actor injects the
    // per-page result in the content process; this seam keeps ContentHide's
    // click-to-hide passes reading the same rules.
    this.wireHiding({
      cosmeticSelectors: (url, classes, ids) =>
        Blocker.cosmeticPayload(url, classes, ids).selectors,
    });
    const principal = systemPrincipalOf(container);
    const tabOf = new Map(); // astra_tab_id -> native tab
    const idOf = new WeakMap(); // native tab -> astra_tab_id
    historyWindows.set(win, tabOf);
    refreshTabHistoryDriver();
    const browsers = new Map(); // astra_tab_id -> { browser, tab }
    const pending = new Map(); // astra_tab_id -> URL to load on first activation
    const historyMoves = new Map(); // astra_tab_id -> "back" | "forward" still settling
    __setFaviconEventSink((view) => emit("favicons-changed", view));
    let applying = false;

    const idOfTab = (tab) => {
      if (!tab) return "";
      return idOf.get(tab) || tab.getAttribute("astra-tab-id") || "";
    };
    /**
     * The URL a tab is for, including a lazily restored tab that has not been
     * selected yet. A pending tab's `currentURI` is about:blank, but
     * SessionStore already knows the saved URL; reading it here is what keeps
     * "continue where you left off" from looking like an empty session.
     */
    const urlOfTab = (tab) => {
      try {
        if (tab?.hasAttribute?.("pending")) {
          const lazy = win?.SessionStore?.getLazyTabValue?.(tab, "url");
          if (typeof lazy === "string" && lazy !== "") return lazy;
        }
      } catch {
        // SessionStore is not available in this window.
      }
      try {
        return tab?.linkedBrowser?.currentURI?.spec || "";
      } catch {
        return "";
      }
    };
    const bindTab = (id, tab) => {
      if (!id || !tab) return;
      tab.setAttribute("astra-tab-id", id);
      // Peek/split read the space from the native tab; this is the one place
      // that knows both the Astra model and the native element.
      try {
        const space = __tabsState().tabs.get(id)?.space_id ?? "";
        if (space) tab.setAttribute("astra-space-id", space);
      } catch {
        // A tab adopted before the model row exists.
      }
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
          if (
            spec &&
            spec !== "about:blank" &&
            !spec.startsWith("chrome://browser/content/blanktab")
          ) {
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
    // The sidebar player follows whatever is playing, including the tab in
    // front: a video the person is watching is still something they can
    // pause, seek and picture-in-picture. The engine controller lives per
    // browser; a private window projects nothing. Position/duration arrive
    // only when the page publishes them.
    const mediaStates = new Map(); // astra_tab_id -> state
    const mediaSuppressed = new Map(); // astra_tab_id -> play generation at close
    let mediaClock = 0;
    const mediaView = (id) => {
      const state = mediaStates.get(id);
      if (!state) return null;
      const controller = state.controller;
      const tab = tabOf.get(id);
      let active = false;
      let playing = false;
      let pip = false;
      try {
        active = controller.isActive === true;
        playing = controller.isPlaying === true;
      } catch {
        active = false;
        playing = false;
      }
      try {
        pip =
          tab?.pictureinpicture === true ||
          tab?.hasAttribute?.("pictureinpicture") === true;
      } catch {
        pip = false;
      }
      // One source of truth for the dispatch path too: the observer may have
      // missed an attribute edge, but the card always reads the tab live.
      state.in_pip = pip;
      if (active !== state.active) {
        state.active = active;
        if (active) state.activeSince = ++mediaClock;
      }
      if (playing !== state.playing) {
        state.playing = playing;
        state.playSince = playing ? ++mediaClock : 0;
        // A closed player comes back the next time its tab starts playing,
        // not on the next position tick from the same playback.
        if (playing && mediaSuppressed.has(id)) mediaSuppressed.delete(id);
      }
      if (mediaSuppressed.has(id)) return null;
      // An inactive controller is not the same as "nothing playing": Gecko
      // deactivates one when playback pauses, and a tab can still be audible
      // (or be the source of a PiP clone) while the controller is idle. Only
      // drop the card when the tab offers no live signal at all.
      let audible = false;
      try {
        audible = tab?.soundPlaying === true || controller.isAudible === true;
      } catch {
        audible = false;
      }
      if (!active && !playing && !audible && !pip) return null;
      let metadata = null;
      try {
        metadata = controller.getMetadata?.() ?? null;
      } catch {
        metadata = null;
      }
      let contentTitle = "";
      try {
        contentTitle = state.browser?.contentTitle ?? "";
      } catch {
        contentTitle = "";
      }
      let site = "";
      try {
        site = state.browser.currentURI?.host ?? "";
      } catch {
        site = "";
      }
      const title = String(
        metadata?.title || tab?.label || contentTitle || site,
      ).trim();
      if (title === "") return null;
      let muted = false;
      try {
        muted = state.browser.audioMuted === true;
      } catch {
        muted = false;
      }
      return {
        tab_id: id,
        title,
        artist: String(metadata?.artist || site || ""),
        icon: null,
        duration: state.duration ?? null,
        position: state.position ?? null,
        rate: state.rate ?? null,
        playing,
        waiting: !playing && active,
        // The engine's PiP launcher can toggle any playing video in this
        // browser; while a player is open the same control restores it, so it
        // stays available even when playback is paused.
        can_pip: playing || pip,
        in_pip: pip,
        muted,
        can_mute: true,
      };
    };
    const clearMedia = () => {
      const showing = Media.view(window_id)?.tab_id;
      if (showing) Media.__projectMedia(showing, null, window_id);
    };
    const projectCurrentMedia = () => {
      // A private window records nothing and owns no card: never touch the
      // projection another window is showing.
      if (isPrivateWindow(win)) return;
      const views = new Map();
      const candidates = [];
      for (const id of mediaStates.keys()) {
        const state = mediaStates.get(id);
        const view = mediaView(id);
        views.set(id, view);
        candidates.push({
          id,
          live: view !== null,
          playing: state?.playing === true,
          playSince: state?.playSince ?? 0,
          activeSince: state?.activeSince ?? 0,
        });
      }
      const currentId = Media.view(window_id)?.tab_id ?? "";
      const currentLive = candidates.some((entry) => entry.id === currentId && entry.live);
      const next = chooseMedia({ currentId, currentLive, candidates });
      if (next === null) {
        clearMedia();
        return;
      }
      Media.__projectMedia(next, views.get(next) ?? mediaView(next), window_id);
    };
    const detachMedia = (id) => {
      const state = mediaStates.get(id);
      if (state) {
        try {
          state.pipObserver?.disconnect();
        } catch {
          // Already detached.
        }
        for (const [type, fn] of state.listeners) {
          try {
            state.controller.removeEventListener(type, fn);
          } catch {
            // The browser went away with the controller.
          }
        }
        mediaStates.delete(id);
      }
      mediaSuppressed.delete(id);
      projectCurrentMedia();
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
      let inPip = false;
      try {
        inPip = tabOf.get(id)?.hasAttribute?.("pictureinpicture") === true;
      } catch {
        inPip = false;
      }
      const state = {
        browser,
        controller,
        position: null,
        duration: null,
        rate: null,
        in_pip: inPip,
        audible: null,
        active: false,
        playing: false,
        playSince: 0,
        activeSince: 0,
        listeners: [],
      };
      // Keep the tab projection's audio flag in step with the engine. The
      // rail's "Now playing" list reads that flag, not a guess.
      const projectAudible = () => {
        let audible = false;
        try {
          const nativeTab = tabOf.get(id);
          audible =
            nativeTab?.soundPlaying === true || state.controller.isAudible === true;
        } catch {
          audible = false;
        }
        // Position events fire continuously; only a real audio edge is worth
        // re-projecting the tab list.
        if (state.audible === audible) return;
        state.audible = audible;
        __applyExternalUpdate(id, { audible });
      };
      const refresh = () => {
        projectAudible();
        projectCurrentMedia();
      };
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
      // The PiP code sets `pictureinpicture` on the native tab directly, not
      // through the tabbrowser helper, so no TabAttrModified arrives. Watch
      // the one attribute on the one tab; it is released with the media state.
      let pipObserver = null;
      const nativeTab = tabOf.get(id);
      try {
        if (nativeTab) {
          pipObserver = new win.MutationObserver(() => {
            const inPip = nativeTab.hasAttribute("pictureinpicture");
            if (state.in_pip === inPip) return;
            state.in_pip = inPip;
            // Automatic PiP opens after the tab has already been hidden, so
            // the source may have been parked before the engine set this
            // marker. A parked source stops feeding frames and transport
            // state to the clone, leaving the player on its last frame while
            // audio plays. Keep the source live with the marker, and let the
            // selection in front decide again once the player closes.
            let selected = false;
            try {
              const split = gb.selectedTab?.splitview;
              selected =
                gb.selectedTab === nativeTab ||
                (split ? split.tabs.includes(nativeTab) : false);
            } catch {
              selected = false;
            }
            applyBrowserActivation(browser, inPip || selected);
            projectCurrentMedia();
          });
          pipObserver.observe(nativeTab, {
            attributes: true,
            attributeFilter: ["pictureinpicture"],
          });
        }
      } catch {
        pipObserver = null;
      }
      state.pipObserver = pipObserver;
      // A tab bound while its player is already open is a PiP source too.
      if (inPip) applyBrowserActivation(browser, true);
      // The controller only forwards a few event types while inactive
      // (`audiblechange` among them). The native tab attributes are the
      // fallback for a tab whose sound or mute state changes without one.
      state.refresh = refresh;
      mediaStates.set(id, state);
      refresh();
    };
    // The engine owns the player window. The card's PiP control asks it to
    // come back when one is already open; the weak map is the engine's own
    // player -> originating browser link, so no second guess is stored here.
    const findPipWindow = (browser) => {
      if (!browser) return null;
      try {
        const services = win.Services;
        const CU = win.ChromeUtils ?? globalThis.ChromeUtils;
        if (!services?.wm || typeof CU?.importESModule !== "function") return null;
        const { PictureInPicture } = CU.importESModule(
          "resource://gre/modules/PictureInPicture.sys.mjs",
        );
        for (const pipWin of services.wm.getEnumerator("Toolkit:PictureInPicture")) {
          if (
            !pipWin.closed &&
            PictureInPicture.weakWinToBrowser?.get(pipWin) === browser
          ) {
            return pipWin;
          }
        }
      } catch {
        // No PiP module or no player window in this engine.
      }
      return null;
    };
    // A player is a detour, not a second home: selecting the tab it was
    // cloned from brings the video back into the page. The engine closes its
    // own auto-PiP on the tab's TabSelect; a player opened from the Now
    // playing card is not in that map, so the foreground close runs here
    // through the player's own path (which unpips without pausing).
    const closeForegroundPip = (browser) => {
      const pipWin = findPipWindow(browser);
      if (!pipWin) return false;
      try {
        if (typeof pipWin.closeFromForeground === "function") {
          pipWin.closeFromForeground();
        } else {
          pipWin.close();
        }
        return true;
      } catch {
        return false;
      }
    };
    const mediaEngine = isPrivateWindow(win) ? null : {
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
            projectCurrentMedia();
            return true;
          case "pause":
            if (!controller) return false;
            try {
              controller.pause();
            } catch {
              return false;
            }
            projectCurrentMedia();
            return true;
          case "seek":
            if (!controller || !Number.isFinite(action.seconds)) return false;
            try {
              controller.seekTo(action.seconds, false);
            } catch {
              return false;
            }
            projectCurrentMedia();
            return true;
          case "picture_in_picture": {
            // A player window that is already open may be behind the browser
            // window; the card brings it forward instead of opening a second
            // one. `in_pip` comes from the engine's own tab attribute, so a
            // player the person minimized (closed) no longer answers here.
            if (state?.in_pip) {
              const pipWin = findPipWindow(state.browser);
              if (pipWin) {
                try {
                  pipWin.restore();
                } catch {
                  // Already restored or the window manager refused.
                }
                try {
                  pipWin.focus();
                } catch {
                  // The window may be closing; the tab still plays.
                }
                projectCurrentMedia();
                return true;
              }
            }
            // The engine's own launcher actor finds the playing video in
            // this browser and toggles it. This is the same entry point the
            // automatic tab-switch path uses, so it works for the video a
            // person is watching without needing a clicked element.
            let actor = null;
            try {
              actor = state?.browser?.browsingContext?.currentWindowGlobal?.getActor(
                "PictureInPictureLauncher",
              );
            } catch {
              actor = null;
            }
            if (!actor || typeof actor.sendAsyncMessage !== "function") return false;
            try {
              actor.sendAsyncMessage("PictureInPicture:AstraToggle");
            } catch {
              return false;
            }
            return true;
          }
          case "show":
            void Tabs.select({ request_id: `media-show-${id}`, astra_tab_id: id });
            return true;
          case "close":
            if (state) mediaSuppressed.set(id, state.playSince ?? 0);
            projectCurrentMedia();
            return true;
          default:
            return false;
        }
      },
    };
    if (mediaEngine) Media.__setEngine(mediaEngine, window_id);
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
      __setTabGroup(id, null);
      tabOf.delete(id);
      browsers.delete(id);
      pending.delete(id);
      historyMoves.delete(id);
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
    const ensureTab = (id, url, tabIndex = -1) => {
      let tab = tabOf.get(id);
      if (tab) return tab;
      applying = true;
      try {
        // Reuse the tabbrowser's initial about:blank tab instead of leaving
        // an unbound tab beside the model's first tab.
        const wanted = contextFor(id);
        const free = [...gb.tabs].find((candidate) => {
          if (idOfTab(candidate)) return false;
          // A pending/restored tab is a saved page, not a free bootstrap tab:
          // its currentURI is still about:blank until it is first selected.
          if (candidate.hasAttribute("pending") || candidate.hasAttribute("restored")) {
            return false;
          }
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
          if (Number.isInteger(tabIndex) && tabIndex >= 0) {
            try {
              gb.moveTabTo(tab, { tabIndex });
            } catch {
              // A tab not yet in the container keeps its place.
            }
          }
          if (isLoadableUrl(url)) pending.set(id, url);
          return tab;
        }
        const options = {
          triggeringPrincipal: principal,
          inBackground: true,
          userContextId: wanted,
        };
        // The model already decided the display position; give the engine the
        // same index so the native strip and the sidebar cannot disagree.
        if (Number.isInteger(tabIndex) && tabIndex >= 0) {
          options.tabIndex = tabIndex;
        }
        tab = gb.addTab("about:blank", options);
        bindTab(id, tab);
        if (isLoadableUrl(url)) pending.set(id, url);
      } finally {
        applying = false;
      }
      return tab;
    };
    const loadIn = (id, url, force = false) => {
      const tab = tabOf.get(id);
      const blank = url === "about:blank";
      if (!tab || (!isLoadableUrl(url) && !blank)) return;
      const browser = tab.linkedBrowser;
      try {
        allowGlobalHistory(browser);
        if (!force && browser?.currentURI?.spec === url) return;
        if (blank) {
          // The New Tab is a real history place now: loading it is how Back
          // reaches it when the engine has no earlier entry to traverse to.
          browser?.loadURI("about:blank", { triggeringPrincipal: principal });
        } else {
          browser?.fixupAndLoadURIString(url, { triggeringPrincipal: principal });
        }
      } catch {
        // A tab torn down mid-load.
      }
    };
    // The nearest model tabs already bound on each side of a native tab. An
    // engine-created tab is adopted at this position instead of the end.
    const nativeNeighbours = (nativeTab) => {
      let after = "";
      let before = "";
      try {
        const all = [...gb.tabs];
        const at = all.indexOf(nativeTab);
        if (at < 0) return { after, before };
        for (let i = at - 1; i >= 0; i -= 1) {
          const id = idOfTab(all[i]);
          if (id) {
            after = id;
            break;
          }
        }
        for (let i = at + 1; i < all.length; i += 1) {
          const id = idOfTab(all[i]);
          if (id) {
            before = id;
            break;
          }
        }
      } catch {
        // A tab leaving its container keeps the fallback position.
      }
      return { after, before };
    };
    const selectTab = (id) => {
      const tab = tabOf.get(id);
      if (!tab) return;
      const wasSelected = gb.selectedTab === tab;
      if (!wasSelected) {
        applying = true;
        try {
          gb.selectedTab = tab;
        } finally {
          applying = false;
        }
      }
      // The tabbox is only the visual deck. The page itself has to be told it
      // is hidden, or a background video never fires VideoTabHidden and the
      // automatic picture-in-picture window cannot open. Every pane of a
      // native split stays active; parking the siblings made them go dark.
      const split = tab.splitview;
      const active = split
        ? split.tabs.map((member) => idOfTab(member)).filter(Boolean)
        : [id];
      applyTabActivation(browsers, active);
      // Only a real return to the tab brings the video back. A redundant
      // re-activation (the model re-asserting the tab already in front, which
      // happens while playback and the player update) must leave the player
      // alone. Every pane of a split counts: its page is in front again.
      if (!wasSelected) {
        for (const memberId of active) {
          closeForegroundPip(tabOf.get(memberId)?.linkedBrowser);
        }
      }
    };
    const activate = (id) => {
      const url = pending.get(id);
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

    // Native -> model: selection, close and both edges of a document load
    // (`busy` is raised when the browser starts fetching and cleared when it
    // has finished). The progress listener keeps the title/URL side; this
    // keeps the loading flag honest, including loads the model never asked
    // for itself: a tab created straight on an address, a link click, a
    // redirect. Without the raised edge such a tab sat on a blank stage with
    // no cover until the document landed.
    const onAttr = (event) => {
      const tab = event.target;
      const id = idOfTab(tab);
      if (!id) return;
      const changed = event.detail?.changed ?? [];
      if (changed.includes("busy") && tab.hasAttribute("busy")) {
        __applyExternalUpdate(id, { loading: true });
      }
      if (changed.includes("busy") && !tab.hasAttribute("busy")) {
        historyMoves.delete(id);
        __applyExternalUpdate(id, { loading: false });
        refreshIcon(id);
      }
      // ESR 153 no longer calls `onTitleChange` on tab progress listeners; the
      // engine publishes the title as the native tab's `label` attribute.
      if (changed.includes("label")) {
        let title = "";
        try {
          title = tab.label || tab.linkedBrowser?.contentTitle || "";
        } catch {
          title = "";
        }
        if (typeof title === "string" && title !== "") {
          void Tabs.setTitle({ astra_tab_id: id, title });
        }
      }
      // Sound and mute are native tab attributes; they are the fallback when
      // a controller event is dropped while it is inactive. PiP state is
      // watched per tab in `attachMedia`, where the tab is known.
      if (changed.includes("soundplaying") || changed.includes("muted")) {
        mediaStates.get(id)?.refresh?.();
      }
    };
    gb.tabContainer.addEventListener("TabAttrModified", onAttr);
    // A native close removes the tab and then selects the engine's own
    // successor. While that settles, `tabs.after-close` is the authority, so
    // the engine's selection must not overwrite the model's choice.
    let nativeClosing = 0;
    const onSelect = () => {
      if (applying || nativeClosing > 0) return;
      const id = idOfTab(gb.selectedTab);
      if (id) {
        const split = gb.selectedTab?.splitview;
        const active = split
          ? split.tabs.map((member) => idOfTab(member)).filter(Boolean)
          : [id];
        applyTabActivation(browsers, active);
        for (const memberId of active) {
          closeForegroundPip(tabOf.get(memberId)?.linkedBrowser);
        }
        void Tabs.select({ astra_tab_id: id });
      } else {
        // An engine-created tab is in front. P4.3 adopts it; until then put
        // the model's tab back rather than showing a page the model lost.
        const selected = __tabsState().selectedId;
        if (selected) activate(selected);
      }
      // The player follows the tab behind the page in front.
      projectCurrentMedia();
    };
    const onClose = (event) => {
      if (applying) return;
      const id = idOfTab(event.target);
      if (!id) return;
      // The engine can select the successor before it reports TabClose. The
      // model must still treat the tab being removed as the one in front, or
      // `tabs.after-close` has no tab to step from.
      if (__tabsState().selectedId !== id) {
        void Tabs.select({ astra_tab_id: id });
      }
      nativeClosing += 1;
      void Tabs.close({ astra_tab_id: id });
      // Closing the last tab produces no successor selection; never leave the
      // guard raised past the removal turn.
      setTimeout(() => {
        nativeClosing = 0;
      }, 1000);
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
      const { after, before } = nativeNeighbours(tab);
      const id = __adoptNative({
        url,
        selected: tab.selected === true,
        window_id: window_id || DEFAULT_WINDOW_ID,
        after,
        before,
      });
      bindTab(id, tab);
      __announceAdopted(id, { selected: tab.selected === true });
    };
    // Native tab groups feed the same projection the sidebar reads. A group
    // is engine-owned; this only copies its identity/label/colour so Astra
    // can draw the header the hidden tab strip would have drawn.
    const projectGroups = () => {
      let changed = false;
      for (const tab of gb.tabs ?? []) {
        const id = idOfTab(tab);
        if (!id) continue;
        const group = tab.group ?? null;
        const next = group
          ? {
              id: String(group.id ?? ""),
              label: group.label ?? "",
              color: typeof group.color === "string" ? group.color : null,
              collapsed: group.collapsed === true,
            }
          : null;
        changed = __setTabGroup(id, next) || changed;
      }
      if (changed) emitItemsChanged();
    };
    const groupEvents = [
      "TabGroupCreate",
      "TabGroupRemoved",
      "TabGroupUpdate",
      "TabGrouped",
      "TabUngrouped",
      "TabGroupMoved",
    ];
    for (const type of groupEvents) win.addEventListener(type, projectGroups);

    const progress = makeProgressListener({
      tabIdOf: (browser) => idOfTab(gb.getTabForBrowser(browser)),
      // A Back/Forward move traverses the engine's own session history. Keep
      // that direction on the commits the traversal produces so the model
      // rewrites the entry it is on instead of pushing a new one and
      // truncating the pages ahead.
      commit: (id, url, extra = {}) => {
        const direction = historyMoves.get(id) ?? null;
        const result = __commitExternal(
          id,
          url,
          direction ? { ...extra, history: direction } : extra,
        );
        if (direction && extra.loading !== true) historyMoves.delete(id);
        return result;
      },
      onCommit: (id, url) => {
        if (!isPrivateWindow(win)) noteTabVisit(id, url);
      },
      onStop: (id, browser) => {
        // A load can stop without a commit (a bfcache traversal, a cancelled
        // request, a same-document move). Clear the history direction and the
        // loading cover here so Back cannot leave an inert layer over the page
        // and the next navigation is not mistaken for another traversal.
        historyMoves.delete(id);
        __applyExternalUpdate(id, { loading: false });
        refreshIcon(id);
        // The engine's failed page is its own about:neterror document. Read
        // the document that really landed so the app can draw Astra's page
        // instead of the native one.
        try {
          const spec = browser?.documentURI?.spec ?? "";
          if (spec.startsWith("about:neterror") || spec.startsWith("about:blocked")) {
            DialogPrompts.netErrorFor({ failedURI: spec, tabId: id });
          }
        } catch {
          // A browser torn down as the load stopped.
        }
      },
      onErrorPage: ({ astra_tab_id, url, browser }) => {
        void DialogPrompts.certErrorFor({ browser, failedURI: url, tabId: astra_tab_id }).then(
          (handled) => {
            if (handled) return;
            // The error document is committed in this same turn; set the
            // app's failed page after that commit so Navigation does not
            // clear it again.
            setTimeout(() => {
              DialogPrompts.netErrorFor({ failedURI: url, tabId: astra_tab_id });
            }, 0);
          },
        );
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
        ensureTab(id, event.data.url, event.data.index);
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
      if (event.type === "tab.space-changed" && id) {
        try {
          tabOf.get(id)?.setAttribute("astra-space-id", event.data.space_id ?? "");
        } catch {
          // A tab leaving with its window.
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
          projectCurrentMedia();
        }
        return;
      }
      if (event.type === "nav.committed" && id && event.data.history) {
        // Back/Forward uses the browser's own session history, so bfcache,
        // redirects, POST results, scroll position and form state survive.
        // The model already stepped to its target; the progress listener
        // folds the address the engine really landed on back into that entry.
        const tab = tabOf.get(id);
        const browser = tab?.linkedBrowser;
        const direction = event.data.history === "forward" ? "forward" : "back";
        const target = event.data.history_index;
        let moved = false;
        if (browser) {
          historyMoves.set(id, direction);
          try {
            if (Number.isInteger(target)) {
              // A row in the history menu names an exact entry, so jump to it
              // instead of stepping: the engine may have skipped entries the
              // model still lists, and one Back would land in the wrong place.
              browser.gotoIndex(target);
              moved = true;
            } else {
              const can =
                direction === "back"
                  ? browser.canGoBackIgnoringUserInteraction === true
                  : browser.canGoForward === true;
              if (can) {
                if (direction === "back") browser.goBack(false);
                else browser.goForward(false);
                moved = true;
              }
            }
          } catch {
            moved = false;
          }
        }
        if (!moved) {
          historyMoves.delete(id);
          loadIn(id, event.data.url, true);
        }
        return;
      }
      if (event.type === "nav.committed" && id && event.data.external !== true) {
        pending.delete(id);
        loadIn(id, event.data.url, true);
        refreshIcon(id);
        if (!isPrivateWindow(win)) noteTabVisit(id, event.data.url);
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
        url = urlOfTab(tab) || url;
        title = tab.linkedBrowser?.contentTitle || "";
      } catch {
        // A tab that is still restoring.
      }
      const { after, before } = nativeNeighbours(tab);
      const id = __adoptNative({
        url,
        selected: tab.selected === true,
        window_id: window_id || DEFAULT_WINDOW_ID,
        after,
        before,
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
      // The bootstrap row is blank in the model *and* still blank natively.
      // A lazily restored page also reads about:blank in the model, so the
      // native URL (SessionStore's saved URL for a pending tab) decides.
      const blank = rows.find((t) => {
        if (t.url && t.url !== "about:blank") return false;
        const spec = urlOfTab(tabOf.get(t.astra_tab_id));
        return (
          !spec ||
          spec === "about:blank" ||
          spec.startsWith("chrome://browser/content/blanktab")
        );
      });
      const restored = rows.filter((t) => t !== blank);
      if (blank && restored.length > 0) {
        const chosen = restored.find((t) => t.selected) ?? restored[0];
        await Tabs.close({ astra_tab_id: blank.astra_tab_id });
        await Tabs.select({ astra_tab_id: chosen.astra_tab_id });
      }
    } catch {
      // Restore is best-effort; never block a working window.
    }

    // `tabs.archive` is a browser-wide policy with a per-window timer. The
    // sweep closes idle Today tabs without touching Places history; detach
    // stops this window's timer, as does closing the window.
    const archiveWindow = window_id || DEFAULT_WINDOW_ID;
    __startArchiveScheduler({ window_id: archiveWindow });

    // A restored session can carry split views. `split.restore` off means the
    // pages come back as ordinary tabs, not as a split.
    try {
      const restore =
        win.Services?.prefs?.getStringPref("astra.settings.split.restore", "true") !== "false";
      if (!restore) {
        for (const splitview of gb.splitViews ?? []) {
          splitview.unsplitTabs("astra_setting");
        }
      }
    } catch {
      // No preference service: keep the engine's restore.
    }

    projectGroups();

    // Hand the one native tab map to the split-view module. It projects the
    // engine's TabSplitView membership and never keeps a second tab list.
    __bindSplitWindow({ window_id: archiveWindow, win, tabOf, idOf });

    return {
      native: true,
      get browser() {
        return gb.selectedBrowser ?? null;
      },
      browsers,
      detach() {
        off();
        __flushSpaceHistory();
        __unbindSplitWindow(archiveWindow);
        __forgetWindow(archiveWindow);
        Media.__setEngine(null, window_id);
        for (const id of [...mediaStates.keys()]) detachMedia(id);
        try { gb.tabContainer.removeEventListener("TabSelect", onSelect); } catch {}
        try { gb.tabContainer.removeEventListener("TabClose", onClose); } catch {}
        try { gb.tabContainer.removeEventListener("TabOpen", onOpen); } catch {}
        try { gb.tabContainer.removeEventListener("TabAttrModified", onAttr); } catch {}
        for (const type of groupEvents) {
          try { win.removeEventListener(type, projectGroups); } catch {}
        }
        try { gb.removeTabsProgressListener(progress); } catch {}
        historyWindows.delete(win);
        refreshTabHistoryDriver();
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
