/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The page's own context menu, in the product's interface.
//
// Firefox builds `contentAreaContextMenu` in the parent the moment a page is
// right-clicked; the menu is native chrome and the owner's rule is that only
// Astra's interface may appear. This module watches that popup, refuses the
// native one for a page that belongs to the Astra content stage, turns the
// engine's `nsContextMenu` state into a small item list, and hands it to the
// app frame. Choosing a row comes back as a message and runs here, where the
// chrome window's own objects (`nsContextMenu`, `openLinkIn`, Places) live.
//
// Nothing is stored between menus beyond the one `nsContextMenu` the current
// menu is acting on. It is dropped when the menu closes, when a row runs, or
// when the window goes away, so a page cannot leave a reference behind.

const SHELL_NS = "astra-shell";

/** Result of a menu action; the caller only needs to know it finished. */
const NOTHING = Object.freeze({ accepted: true });

export function isContentBrowser(win, browser) {
  if (!browser || typeof browser.hasAttribute !== "function") {
    return false;
  }
  if (browser.hasAttribute("data-astra-browser") || browser.hasAttribute("data-astra-browser-parked")) {
    return true;
  }
  // The native deck docks `gBrowser`'s selected browser over the Astra content
  // slot; the browser is no longer a DOM child of that slot (it lives in
  // `#tabbrowser-tabbox`), so `contains()` alone left the engine's own page
  // menu answering a right-click. A browser the window's tabbrowser owns is
  // still the content stage, whether or not it can be found by containment.
  try {
    if (win.gBrowser?.getTabForBrowser?.(browser)) {
      return true;
    }
  } catch {
    // A window still assembling its tabbrowser.
  }
  try {
    if (browser.getTabBrowser?.() === win.gBrowser) {
      return true;
    }
  } catch {
    // No tabbrowser relationship on this browser.
  }
  try {
    const slot = win.document.querySelector("[data-astra-content]");
    return !!slot && slot.contains(browser);
  } catch {
    return false;
  }
}

function screenPoint(win, context) {
  const dpr = win.devicePixelRatio || 1;
  const screenX = Number(context?.screenXDevPx) / dpr;
  const screenY = Number(context?.screenYDevPx) / dpr;
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) {
    return { x: 0, y: 0 };
  }
  // The app frame starts at the window's content origin, which is
  // `mozInnerScreen*`, not the outer window position (decorations sit between).
  const originX = Number.isFinite(win.mozInnerScreenX) ? win.mozInnerScreenX : win.screenX;
  const originY = Number.isFinite(win.mozInnerScreenY) ? win.mozInnerScreenY : win.screenY;
  return { x: Math.round(screenX - originX), y: Math.round(screenY - originY) };
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** The play/pause label asks the tab's own media controller, not a guess. */
function isPlaying(browser) {
  try {
    return browser.browsingContext?.mediaController?.isPlaying === true;
  } catch {
    return false;
  }
}

function item(id, label, extra = {}) {
  return { id, label, ...extra };
}

const SEP = { kind: "separator" };

/** The rows this click can offer. Only the groups the engine confirmed show. */
function buildItems(menu, browser) {
  const items = [];
  const add = (...rows) => items.push(...rows);
  const gap = () => {
    if (items.length > 0 && items[items.length - 1] !== SEP) items.push(SEP);
  };

  if (menu.onLink && menu.linkURL) {
    add(
      item("link.open", "Open Link in New Tab"),
      item("link.openSplit", "Open Link in Split View"),
      item("link.preview", "Preview Link"),
      item("link.openWindow", "Open Link in New Window"),
      item("link.openPrivate", "Open Link in New Private Window"),
      item("link.copy", "Copy Link Address"),
      item("link.bookmark", "Bookmark This Link"),
    );
    gap();
  }

  if (menu.onVideo || menu.onAudio) {
    add(item(isPlaying(browser) ? "media.pause" : "media.play", isPlaying(browser) ? "Pause" : "Play"));
    add(item(browser.audioMuted ? "media.unmute" : "media.mute", browser.audioMuted ? "Unmute" : "Mute"));
    add(item("media.loop", "Loop"));
    add(item("media.controls", "Show Controls"));
    add(item("media.fullscreen", "Full Screen"));
    if (menu.onPiPVideo) add(item("media.pip", "Watch in Picture-in-Picture"));
    gap();
  } else if (menu.onImage && menu.mediaURL) {
    add(item("image.open", "Open Image in New Tab"), item("image.copy", "Copy Image Address"), item("image.save", "Save Image As…"));
    gap();
  }

  add(
    item("page.preview", "Preview This Page"),
    item("page.split", "Open Page in Split View"),
  );
  gap();

  if (menu.isContentSelected && menu.selectedText) {
    add(item("page.copy", "Copy"));
    add(item("page.search", "Search Google for “…”", { hint: "Google" }));
    gap();
  }

  add(
    item("page.bookmark", "Bookmark This Page"),
    item("page.save", "Save Page As…"),
    item("page.viewSource", "View Page Source"),
    SEP,
    item("page.devtools", "Inspect"),
    item("page.selectAll", "Select All"),
  );

  // A trailing separator would be drawn as a line against the window edge.
  while (items.length > 0 && items[items.length - 1] === SEP) items.pop();
  return items;
}

/** Stand-in tabs for browsers the tab strip does not own (one per browser,
 *  kept for the toolbox's lifetime). DevTools attaches listeners to the tab
 *  element and resolves the browser through `linkedBrowser`; a plain object
 *  made it throw at the first `addEventListener`. */
const _devTabs = new WeakMap();

/**
 * The tab DevTools attaches to.
 *
 * The content stage is a real `gBrowser` tab (`Content.mountNative`), so the
 * toolbox gets that tab: it carries the tab's own container (`userContextId`),
 * panel, window and the tab events the toolbox listens for. A browser the tab
 * strip does not own yet (a window before the first mount) gets a stand-in.
 *
 * @param {Window} win the browser window
 * @param {Element} browser the content browser DevTools acts on
 * @returns {Element} a tabbrowser tab or a stand-in that quacks like one
 */
export function devTabFor(win, browser) {
  try {
    const tab = win.gBrowser?.getTabForBrowser?.(browser);
    if (tab) {
      return tab;
    }
  } catch {
    // No tab strip in this window; the stand-in below still has what the
    // toolbox reads.
  }
  let tab = _devTabs.get(browser);
  if (!tab) {
    tab = win.document.createXULElement("tab");
    // Some of these names are prototype getters in the chrome realm (the
    // toolbox only reads them); define an own value instead of assigning.
    const own = (name, value) => {
      try {
        tab[name] = value;
      } catch {
        try {
          Object.defineProperty(tab, name, {
            value,
            configurable: true,
            writable: true,
          });
        } catch {
          // The toolbox falls back to the browser it was given.
        }
      }
    };
    own("linkedBrowser", browser);
    own("documentGlobal", win);
    own("linkedPanel", null);
    own("userContextId", 0);
    _devTabs.set(browser, tab);
  }
  return tab;
}

/** Open or close DevTools for an Astra content browser.
 *
 *  `DevToolsShim` is the supported entry point: it initialises DevTools lazily
 *  and works whether or not the toolbox has been opened before. The toolbox
 *  gets a window of its own because the native tabbox that hosts a docked
 *  toolbox is hidden in this shell.
 *
 *  `toolId` names a tool (the page menu's Inspect): the toolbox opens — or is
 *  raised — on that tool. Without a tool (F12, Ctrl+Shift+I from the product
 *  keymap) the command toggles, the way the browser's own DevTools key does. */
export async function showDevTools(win, browser, toolId, { reason = "ContextMenu" } = {}) {
  if (!browser) {
    return { accepted: false };
  }
  try {
    const { DevToolsShim } = win.ChromeUtils.importESModule(
      "chrome://devtools-startup/content/DevToolsShim.sys.mjs",
    );
    if (!DevToolsShim?.isEnabled?.()) {
      return { accepted: false };
    }
    const tab = devTabFor(win, browser);
    if (toolId === undefined) {
      const open = DevToolsShim.getToolboxForTab?.(tab);
      if (open) {
        await open.destroy();
        return { accepted: true, closed: true };
      }
    }
    await DevToolsShim.showToolboxForTab(tab, {
      toolId,
      hostType: "window",
      reason,
    });
    return { accepted: true };
  } catch (error) {
    // The caller reports "accepted: false" to the app, so a refusal must
    // leave a trace here or a dead control looks like a working one.
    console.error("astra: DevTools did not open", error);
    return { accepted: false };
  }
}

/**
 * Install the content menu for one chrome window.
 *
 * @param {Window} win the browser window (XUL chrome)
 * @param {{host: object, postToApp: (message: object) => void, tabIdOf: (browser: Element) => string|null}} deps
 * @returns {{run: (id: string) => Promise<object>, destroy: () => void}}
 */
export function installContentMenu(win, { host, showMenu, isFromApp, tabIdOf }) {
  const doc = win.document;
  const popup = doc.getElementById("contentAreaContextMenu");
  const fromApp =
    typeof isFromApp === "function" ? isFromApp : () => false;
  /** The one engine menu the open Astra menu is acting on. */
  let current = null;
  /** A menu the person walks away from must not keep the page's state alive:
   *  the reference is dropped on its own if no row ever comes back. */
  let expiry = 0;
  const arm = () => {
    clearTimeout(expiry);
    expiry = setTimeout(() => {
      current = null;
    }, 15000);
  };
  const release = () => {
    clearTimeout(expiry);
    current = null;
  };
  let destroyed = false;

  const services = () => win.Services;
  const io = () => services().io;

  const copy = (text) => {
    if (typeof text !== "string" || text === "") return;
    try {
      const helper = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(
        Ci.nsIClipboardHelper,
      );
      helper.copyString(text);
    } catch {
      // A denied clipboard is a user-visible no-op.
    }
  };

  async function bookmark({ url, title }) {
    if (typeof url !== "string" || !/^https?:/i.test(url)) return NOTHING;
    // Go through the host module so the bookmark lands in the active space's
    // folder, not the global unfiled root.
    const saved = await host.Bookmarks.call({
      profile: "default",
      call: {
        kind: "add_link",
        parent: null,
        title: typeof title === "string" && title !== "" ? title : hostOf(url),
        url,
      },
    });
    if (!saved || saved.kind !== "saved" || !saved.id) {
      return { accepted: false };
    }
    // The app reveals what it saved: native confirms first, then the panel.
    host.emit?.("ui-command", `bookmark.added=${saved.id}`);
    return { accepted: true, id: saved.id };
  }

  function openBrowserWindow(options) {
    if (typeof win.OpenBrowserWindow === "function") {
      return win.OpenBrowserWindow(options);
    }
    const { BrowserWindowTracker } = win.ChromeUtils.importESModule(
      "resource:///modules/BrowserWindowTracker.sys.mjs",
    );
    return BrowserWindowTracker.openWindow(options);
  }

  function openWindow({ url = "", private: isPrivate = false } = {}) {
    const options = { private: isPrivate === true };
    try {
      const newWin = openBrowserWindow(options);
      // The engine loads its own hidden tab on `about:blank`; the address
      // travels on the window object so no page is fetched twice, and no
      // Firefox tab ever paints. The new window's shell adopts it on mount.
      if (newWin && typeof url === "string" && /^https?:/i.test(url)) {
        newWin.__astraPendingUrl = url;
      }
      return { accepted: !!newWin };
    } catch {
      return { accepted: false };
    }
  }

  async function newTab(url) {
    if (typeof url !== "string" || url === "") return { accepted: false };
    const res = await host.Tabs.create({ url, background: true });
    return { accepted: !res?.error };
  }

  function mediaCommand(menu, command, data) {
    try {
      menu.mediaCommand(command, data);
      return { accepted: true };
    } catch {
      return { accepted: false };
    }
  }

  function reloadTab(browser) {
    try {
      browser.reload();
      return { accepted: true };
    } catch {
      return { accepted: false };
    }
  }

  function search(text) {
    const query = String(text ?? "").trim();
    if (query === "") return { accepted: false };
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    return newTab(url);
  }

  async function run(id) {
    const ctx = current;
    if (!ctx) return { accepted: false };
    const { menu, browser } = ctx;
    try {
      switch (id) {
      case "link.open":
        return newTab(menu.linkURL);
      case "link.openSplit": {
        const target = (() => {
          try {
            return win.Services.prefs.getStringPref("astra.settings.split.link-target", "split");
          } catch {
            return "split";
          }
        })();
        if (target === "tab") return newTab(menu.linkURL);
        const reply = await host.SplitView.openUrl({
          url: menu.linkURL,
          mode: "split",
          placement: "right",
        });
        return { accepted: !reply?.error, split: reply?.split === true };
      }
      case "link.preview": {
        const reply = await host.Peek.open({
          url: menu.linkURL,
          title: menu.linkTextStr,
          source: "context-menu",
        });
        return { accepted: !reply?.error };
      }
      case "link.openWindow":
        return openWindow({ url: menu.linkURL });
      case "link.openPrivate":
        return openWindow({ url: menu.linkURL, private: true });
      case "link.copy":
        copy(menu.linkURL);
        return NOTHING;
      case "link.bookmark":
        return bookmark({ url: menu.linkURL, title: menu.linkTextStr });
      case "image.open":
        return newTab(menu.mediaURL);
      case "image.copy":
        copy(menu.mediaURL);
        return NOTHING;
      case "media.play":
        return mediaCommand(menu, "play");
      case "media.pause":
        return mediaCommand(menu, "pause");
      case "media.mute":
        return mediaCommand(menu, "mute");
      case "media.unmute":
        return mediaCommand(menu, "unmute");
      case "media.loop":
        return mediaCommand(menu, "loop");
      case "media.controls":
        return mediaCommand(menu, "showcontrols");
      case "media.fullscreen":
        return mediaCommand(menu, "fullscreen");
      case "media.pip":
        return mediaCommand(menu, "pictureinpicture");
      case "page.preview": {
        const id = tabIdOf(browser);
        if (!id) return { accepted: false };
        const reply = await host.Peek.open({ tab_id: id, source: "context-menu" });
        return { accepted: !reply?.error };
      }
      case "page.split": {
        const id = tabIdOf(browser);
        if (!id) return { accepted: false };
        const list = await host.Tabs.list({ request_id: "ctx-split" });
        const other = (list.tabs ?? []).find(
          (tab) => tab.astra_tab_id !== id && /^https?:/u.test(tab.url ?? ""),
        );
        if (!other) return { accepted: false };
        const reply = await host.SplitView.open({ source: id, other: other.astra_tab_id });
        return { accepted: !reply?.error, split: reply?.split === true };
      }
      case "page.copy":
        win.goDoCommand?.("cmd_copy");
        return NOTHING;
      case "page.selectAll":
        win.goDoCommand?.("cmd_selectAll");
        return NOTHING;
      case "page.search":
        return search(menu.selectedText);
      case "page.bookmark":
        return bookmark({ url: browser.currentURI?.spec ?? "", title: browser.contentTitle ?? "" });
      case "page.save":
        try {
          win.saveBrowser(browser);
          return { accepted: true };
        } catch {
          return { accepted: false };
        }
      case "page.viewSource":
        host.emit?.("ui-command", "browser.source");
        return NOTHING;
      case "page.devtools":
        return showDevTools(win, browser, "inspector");
      case "page.reload":
        return reloadTab(browser);
      default:
        return { accepted: false };
      }
    } finally {
      // The engine menu is done once a row runs; keep nothing alive.
      release();
    }
  }

  function onPopupShowing(event) {
    if (destroyed || event.target !== popup) return;
    const menu = win.gContextMenu;
    if (!menu || !menu.shouldDisplay) return;
    const browser = menu.browser;
    if (!isContentBrowser(win, browser)) return;
    // The engine's menu never paints. The Astra menu is the only one.
    event.preventDefault();
    const { x, y } = screenPoint(win, menu.contentData?.context);
    current = { menu, browser };
    arm();
    if (typeof showMenu === "function") {
      showMenu({
        x,
        y,
        items: buildItems(menu, browser),
        choose: (id) => run(id),
      });
    }
  }

  // A dismissed/refused engine menu must not leave its state behind either.
  function onPopupHidden() {
    release();
  }

  const onMessage = (event) => {
    const data = event.data;
    if (destroyed || !data || typeof data !== "object" || data.ns !== SHELL_NS) return;
    if (!fromApp(event)) return;
    if (data.kind !== "menu-run" || typeof data.id !== "string") return;
    void run(data.id);
  };

  popup?.addEventListener("popupshowing", onPopupShowing);
  popup?.addEventListener("popuphidden", onPopupHidden);
  win.addEventListener("message", onMessage);

  return {
    run,
    release,
    destroy() {
      destroyed = true;
      release();
      popup?.removeEventListener("popupshowing", onPopupShowing);
      popup?.removeEventListener("popuphidden", onPopupHidden);
      win.removeEventListener("message", onMessage);
    },
  };
}

/** Actions the app's own chrome menu asks for; the shell owns the chrome. */
export async function runChromeAction(win, host, id, { browser = null } = {}) {
  const openWindow = (options) => {
    if (typeof win.OpenBrowserWindow === "function") return win.OpenBrowserWindow(options);
    const { BrowserWindowTracker } = win.ChromeUtils.importESModule(
      "resource:///modules/BrowserWindowTracker.sys.mjs",
    );
    return BrowserWindowTracker.openWindow(options);
  };
  switch (id) {
    case "window.new": {
      const created = await host.Windows.create({
        request_id: `win-${Date.now()}`,
        private: false,
      });
      return { accepted: !created.error };
    }
    case "window.newPrivate": {
      const created = await host.Windows.create({
        request_id: `win-${Date.now()}`,
        private: true,
      });
      return { accepted: !created.error };
    }
    case "window.showPrivate":
    case "window.togglePrivate":
    case "window.showRegular": {
      const wantPrivate = id !== "window.showRegular";
      const list = await host.Windows.list({ request_id: `win-${Date.now()}` });
      const found = (list.windows ?? []).find((w) => w.private === wantPrivate);
      if (found) {
        const focused = await host.Windows.focus({
          request_id: `win-${Date.now()}`,
          window_id: found.window_id,
        });
        return { accepted: !focused.error };
      }
      const created = await host.Windows.create({
        request_id: `win-${Date.now()}`,
        private: wantPrivate,
      });
      return { accepted: !created.error };
    }
    case "window.closePrivate": {
      const list = await host.Windows.list({ request_id: `win-${Date.now()}` });
      const found = (list.windows ?? []).find((w) => w.private === true);
      if (!found) return { accepted: false };
      const closed = await host.Windows.close({
        request_id: `win-${Date.now()}`,
        window_id: found.window_id,
      });
      return { accepted: !closed.error };
    }
    case "window.fullscreen": {
      const id = host.__bindCurrentWindow?.(win) || "win-1";
      try {
        const cur = await host.Windows.get({ request_id: `win-${Date.now()}`, window_id: id });
        if (cur?.error) {
          return { accepted: false };
        }
        const out = await host.Windows.setFullscreen({
          request_id: `win-${Date.now()}`,
          window_id: id,
          fullscreen: !(cur.window?.fullscreen === true),
        });
        return { accepted: !out.error };
      } catch {
        return { accepted: false };
      }
    }
    case "page.devtools":
    case "page.devtools.alt":
      return showDevTools(win, browser, undefined, { reason: "KeyShortcut" });
    case "page.save":
      try {
        if (!browser) return { accepted: false };
        win.saveBrowser(browser);
        return { accepted: true };
      } catch {
        return { accepted: false };
      }
    case "page.print":
      try {
        if (!browser) return { accepted: false };
        win.PrintUtils.startPrintWindow(browser.browsingContext, { printToFile: false });
        return { accepted: true };
      } catch {
        return { accepted: false };
      }
    case "page.viewSource":
      host.emit?.("ui-command", "browser.source");
      return { accepted: true };
    case "page.selectAll":
      win.goDoCommand?.("cmd_selectAll");
      return { accepted: true };
    case "page.copy":
      win.goDoCommand?.("cmd_copy");
      return { accepted: true };
    case "bookmark.current":
    case "bookmark.add": {
      try {
        const list = await host.Tabs.list({ request_id: `menu-${Date.now()}` });
        const tabs = list.tabs ?? [];
        const tab = tabs.find((entry) => entry.selected) ?? tabs[0];
        const url = typeof tab?.url === "string" ? tab.url : "";
        if (!/^https?:/i.test(url)) return { accepted: false };
        const saved = await host.Bookmarks.call({
          profile: "default",
          call: {
            kind: "add_link",
            parent: null,
            title: tab.title || hostOf(url),
            url,
          },
        });
        if (!saved || saved.kind !== "saved" || !saved.id) {
          return { accepted: false };
        }
        host.emit?.("ui-command", `bookmark.added=${saved.id}`);
        return { accepted: true, id: saved.id };
      } catch {
        return { accepted: false };
      }
    }
    default:
      return { accepted: false };
  }
}

export { hostOf, screenPoint };
