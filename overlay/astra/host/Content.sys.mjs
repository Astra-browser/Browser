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
  __applyExternalUpdate,
  __spaceUserContextId,
  __tabsState,
} from "./Tabs.sys.mjs";
import { Navigation, __commitExternal } from "./Navigation.sys.mjs";
import { Favicons, __setFaviconEventSink } from "./Favicons.sys.mjs";
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
export function makeProgressListener({ tabIdOf, commit = __commitExternal, setTitle } = {}) {
  const resolveTitle = setTitle ?? ((id, title) => Tabs.setTitle({ astra_tab_id: id, title }));
  return {
    onLocationChange(browser, _progress, _request, location) {
      try {
        const id = tabIdOf ? tabIdOf(browser) : null;
        const url = location && location.spec ? location.spec : "";
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
    // `favicons-changed` is a wire event the app already listens for
    // (DOM_CHANNELS in ui/app/chrome-entry/browser-chrome.ts); the shell
    // relays every Events-pump event to the app frame, so the sink is the
    // pump. Nodes outside chrome never resolve an icon, so no event is ever
    // invented there.
    __setFaviconEventSink((view) => emit("favicons-changed", view));
    /** astra_tab_id -> { browser, requested, poll, abort }; one page per tab,
     *  kept alive. `poll` is the load watcher and `abort` owns the element's
     *  listeners, so every browser releases everything it started. */
    const browsers = new Map();
    /** Every timer this mount owns, so teardown leaves none behind. */
    const timers = new Set();
    /** The tab whose browser is in front ("" when a New Tab owns the stage). */
    let activeId = "";

    const activeBrowser = () => browsers.get(activeId)?.browser ?? null;

    /**
     * Mirror one browser's foreground state into Gecko. Runs for every entry
     * on every switch, so it stays idempotent and cheap; all of it is
     * best-effort because a browser can be torn down mid-switch.
     */
    const applyActivation = (entry, active) => {
      const state = docshellState(active);
      try {
        // Keep background media playing. ESR 153 only suspends a hidden
        // page's media when the top context opts in, and that opt-in is off
        // by default; asserting it here means a future default (or a site
        // that turned it on) cannot silently mute a parked tab.
        const context = entry.browser.browsingContext;
        if (context?.suspendMediaWhenInactive) {
          context.suspendMediaWhenInactive = false;
        }
        if (state.docShellIsActive) {
          entry.browser.docShellIsActive = true;
          entry.browser.preserveLayers(false);
        } else {
          entry.browser.preserveLayers(false);
          entry.browser.docShellIsActive = false;
        }
      } catch {
        // A browser torn down mid-switch: the next one will be set.
      }
    };

    const setActive = (id) => {
      activeId = id;
      for (const [key, entry] of browsers) {
        const active = key === id;
        try {
          if (active) {
            entry.browser.setAttribute("data-astra-browser", "content");
            entry.browser.removeAttribute("data-astra-browser-parked");
          } else {
            entry.browser.removeAttribute("data-astra-browser");
            entry.browser.setAttribute("data-astra-browser-parked", "");
          }
        } catch {
          // A browser torn down mid-switch: the next one will show.
        }
        applyActivation(entry, active);
      }
    };

    // No page in front (a New Tab): every browser stays loaded but parked, so
    // coming back is instant rather than a fresh network load and no parked
    // page keeps painting, running rAF or holding a layer.
    const park = () => {
      activeId = "";
      for (const entry of browsers.values()) {
        try {
          entry.browser.removeAttribute("data-astra-browser");
          entry.browser.setAttribute("data-astra-browser-parked", "");
        } catch {
          // Torn down with the window.
        }
        applyActivation(entry, false);
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
      const beginning = Date.now();
      const deadline = beginning + 60_000;
      // A server can hold the request before a single byte arrives; during
      // that time the browser's load flag is not set yet, and treating that
      // as "done" made the skeleton vanish while the page was still coming.
      // Stay in the loading state until the load has actually started, with
      // a bounded wait for a request that never starts at all.
      const startDeadline = beginning + 15_000;
      let seenLoading = false;
      let idle = 0;
      entry.poll = setInterval(() => {
        let loading = true;
        try {
          loading = entry.browser.webProgress?.isLoadingDocument === true;
        } catch {
          loading = false;
        }
        const step = loadWatchStep({
          loading,
          seenLoading,
          currentUrl: safeSpec(entry.browser),
          requestedUrl: entry.requested,
          previousUrl: entry.previous,
          elapsedMs: Date.now() - beginning,
          startDeadlineMs: startDeadline - beginning,
        });
        if (step.seenLoading) {
          seenLoading = true;
        }
        const live = step.live;
        // A redirect can dip the flag for a moment between documents; two
        // quiet polls after the load has started mean it is really over.
        // A fast committed load skips that grace period: the document is
        // already on screen and the skeleton must not stay over it.
        if (step.fastDone) {
          idle = 2;
        } else if (live) {
          idle = 0;
        } else {
          idle += 1;
        }
        if (Date.now() < deadline && (live || idle < 2)) return;
        stopWatching(entry);
        if (!browsers.has(id)) return;
        // `requested` is what this browser was asked to load, not where the
        // page itself ended up: a page that rewrites its own address must not
        // make the projection ask for the old address again, or the two fight
        // and the page reloads forever.
        __applyExternalUpdate(id, { loading: false });
        const title = safeTitle(entry.browser);
        if (title) __applyExternalUpdate(id, { title });
        // The document has landed, which is when Places holds the icon
        // `LinkHandlerParent` stored. A missing one is retried.
        scheduleIcon(id, entry);
      }, 200);
    };

    /**
     * Read the site icon Places stored for the page this browser landed on and
     * push the reference into the tab model. The page's own icon notification
     * is not a reliable trigger (`LinkHandlerParent` stores the icon either
     * way), and a just-finished load may not have stored it yet, so a missing
     * icon is retried a couple of times before the tab keeps its letter tile.
     * Answers true once nothing more needs doing, false when no icon was
     * found yet.
     */
    const refreshIcon = async (id, entry) => {
      try {
        if (!browsers.has(id) || entry.crashed) {
          return true;
        }
        const ownerDoc = entry.browser.ownerDocument;
        const win = ownerDoc?.defaultView;
        // Private windows read no global favicon: what is browsed there must
        // not appear anywhere else either.
        if (!ownerDoc || !win || isPrivateWindow(win)) {
          return true;
        }
        const url = safeSpec(entry.browser);
        if (!isLoadableUrl(url)) {
          return true;
        }
        const resolved = await Favicons.resolve({ url, doc: ownerDoc });
        if (!resolved) {
          return false;
        }
        if (!browsers.has(id)) {
          return true;
        }
        const key = `${resolved.entry.origin}\u0000${resolved.entry.revision}`;
        if (entry.iconKey === key) {
          // Same pixels the projection already carries: repaint nothing.
          return true;
        }
        entry.iconKey = key;
        Favicons.publish(resolved);
        __applyExternalUpdate(id, {
          icon: {
            origin: resolved.entry.origin,
            revision: resolved.entry.revision,
          },
        });
        return true;
      } catch {
        // A broken icon must never keep a page from working; it is not
        // retried because the failure is not "not stored yet".
        return true;
      }
    };

    /** Resolve now, then twice more while the tab has no icon yet. */
    const scheduleIcon = (id, entry, attempt = 0) => {
      // A site can declare its icon late (a script-set link, a slow 404 for
      // /favicon.ico, a redirect chain). Retry a few times, but always stop;
      // once an icon lands it is stored in Places so this only runs first.
      const delay = attempt === 0 ? 0 : attempt === 1 ? 1200 : attempt === 2 ? 3500 : 7000;
      const timer = setTimeout(() => {
        timers.delete(timer);
        void refreshIcon(id, entry).then((settled) => {
          if (!settled && attempt < 3 && browsers.has(id)) {
            scheduleIcon(id, entry, attempt + 1);
          }
        });
      }, delay);
      timers.add(timer);
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
      // Activeness is owned by this binding, not by the chrome document that
      // embeds the browser. Without this Gecko re-derives it from the (active)
      // chrome window when the content process attaches or changes remoteness,
      // which is how every parked tab ended up active again. Firefox's own
      // tabbrowser sets the same attribute on every browser it creates.
      browser.setAttribute("manualactiveness", "true");
      browser.setAttribute("flex", "1");
      // Parked until a page is in front of it.
      browser.setAttribute("data-astra-browser-parked", "");
      // Every space is a container: a login or cookie set in one is not
      // visible in another. Private windows stay on the window's own context.
      try {
        const tab = __tabsState().tabs.get(id);
        if (tab && !isPrivateWindow(doc.defaultView)) {
          browser.setAttribute(
            "usercontextid",
            String(__spaceUserContextId(tab.space_id)),
          );
        }
      } catch {
        // A browser without a tab record keeps the default context.
      }
      container.append(browser);
      // Remote browsers otherwise inherit the chrome window's
      // `useGlobalHistory = false`, which drops every visit from Places.
      allowGlobalHistory(browser);
      const entry = {
        browser,
        requested: "",
        previous: "",
        poll: 0,
        abort: null,
        crashed: false,
        iconKey: "",
      };
      browsers.set(id, entry);
      // Starts parked: the browser is created for a page that is about to be
      // shown (or warmed on about:blank), and `setActive` turns it on.
      applyActivation(entry, false);
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
        if (!entry.iconKey) {
          // Coming back to a page loaded before its icon was read (or one
          // restored by a session): fill the mark without reloading.
          scheduleIcon(id, entry);
        }
        return;
      }
      entry.crashed = false;
      entry.previous = safeSpec(entry.browser);
      entry.requested = target;
      // The browsing context can be replaced when remoteness changes, so the
      // history flag is set on the context that is about to load.
      allowGlobalHistory(entry.browser);
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
    // Still give that New Tab a browser on about:blank. The first address
    // typed then reuses a warm content process instead of paying a process
    // spawn on the critical path; the page never paints while parked.
    if (selectedId && !browsers.has(selectedId)) {
      const warm = createBrowser(selectedId);
      warm.requested = "about:blank";
      try {
        warm.browser.fixupAndLoadURIString("about:blank", {
          triggeringPrincipal: principal,
        });
      } catch {
        // A browser that refuses the warm-up still loads the first address.
      }
    }

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
          // Coming back to a tab whose icon never landed (it was fetched
          // while the tab was in the background) gets another try now that
          // it is in front; the Places/fetch result is cached after that.
          const entry = browsers.get(active.id);
          if (entry && !active.icon) {
            scheduleIcon(active.id, entry);
          }
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
