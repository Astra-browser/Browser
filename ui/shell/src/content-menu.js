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
  if (
    browser.hasAttribute("data-astra-browser") ||
    browser.hasAttribute("data-astra-browser-parked")
  ) {
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
  const originX = Number.isFinite(win.mozInnerScreenX)
    ? win.mozInnerScreenX
    : win.screenX;
  const originY = Number.isFinite(win.mozInnerScreenY)
    ? win.mozInnerScreenY
    : win.screenY;
  return { x: Math.round(screenX - originX), y: Math.round(screenY - originY) };
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** True for a private chrome window. Bookmarks are durable, so a chrome
 *  shortcut/menu path must check this before it reaches Places: the app's own
 *  bookmark surface is gated in the shell relay, the chrome menu was not. */
function isPrivateWindow(win) {
  try {
    if (win?.PrivateBrowsingUtils?.isWindowPrivate?.(win) === true) {
      return true;
    }
  } catch {
    // Fall through to the module.
  }
  try {
    const { PrivateBrowsingUtils } = win.ChromeUtils.importESModule(
      "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
    );
    return PrivateBrowsingUtils.isWindowPrivate(win) === true;
  } catch {
    return false;
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
    add(
      item(
        isPlaying(browser) ? "media.pause" : "media.play",
        isPlaying(browser) ? "Pause" : "Play",
      ),
    );
    add(
      item(
        browser.audioMuted ? "media.unmute" : "media.mute",
        browser.audioMuted ? "Unmute" : "Mute",
      ),
    );
    add(item("media.loop", "Loop"));
    add(item("media.controls", "Show Controls"));
    add(item("media.fullscreen", "Full Screen"));
    if (menu.onPiPVideo) add(item("media.pip", "Watch in Picture-in-Picture"));
    gap();
  } else if (menu.onImage && menu.mediaURL) {
    add(
      item("image.open", "Open Image in New Tab"),
      item("image.copy", "Copy Image Address"),
      item("image.save", "Save Image As…"),
    );
    gap();
  }

  add(
    item("page.preview", "Preview This Page"),
    item("page.split", "Open Page in Split View"),
  );
  gap();

  const editable = menu.isEditable === true || menu.onTextInput === true;
  const selected =
    (menu.isContentSelected || menu.isTextSelected) && !!menu.selectedText;
  add(
    item("page.copy", "Copy", { disabled: !selected }),
    item("page.cut", "Cut", { disabled: !editable }),
    item("page.paste", "Paste", { disabled: !editable }),
  );
  if (selected)
    add(item("page.search", "Search Google for “…”", { hint: "Google" }));
  gap();

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

/** The size a floating toolbox needs to be usable, in CSS pixels. Below this
 *  the panels cannot lay out: at the engine's 900x320 default the inspector's
 *  own sidebar is taller than the window and everything scrolls in a sliver. */
export const DEVTOOLS_MIN_WIDTH = 760;
export const DEVTOOLS_MIN_HEIGHT = 420;

function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/**
 * Where the floating toolbox should go for one browser window.
 *
 * The engine opens `toolbox-window.xhtml` at its own 900x320 default and then
 * remembers that size forever (`persist="… width height sizemode"`). Astra
 * always uses the window host (the native tabbox is hidden), so without this
 * the product's Inspect surface is a strip on every later open, not just the
 * first. The person's own size is kept once it is usable; only a degenerate
 * window is grown, and a window that opened off the work area is moved back.
 *
 * Pure: it reads the two windows and returns the rect, so the layout rule is
 * testable without DevTools.
 *
 * @param {{screenX?: number, screenY?: number, outerWidth?: number, outerHeight?: number,
 *          screen?: {availLeft?: number, availTop?: number, availWidth?: number, availHeight?: number}}} win
 *   the browser window
 * @param {{left?: number, top?: number, width?: number, height?: number}} [current]
 *   the toolbox window's present rect
 * @returns {{left: number, top: number, width: number, height: number}|null}
 *   null when the toolbox is already usable and fully on the work area
 */
export function devToolsWindowRect(win, current = {}) {
  const screen = win?.screen ?? {};
  const avail = {
    left: Math.round(finite(screen.availLeft, 0)),
    top: Math.round(finite(screen.availTop, 0)),
    width: Math.round(positive(screen.availWidth, 1280)),
    height: Math.round(positive(screen.availHeight, 800)),
  };
  const browser = {
    left: Math.round(finite(win?.screenX, avail.left)),
    top: Math.round(finite(win?.screenY, avail.top)),
    width: Math.round(positive(win?.outerWidth, avail.width)),
    height: Math.round(positive(win?.outerHeight, avail.height)),
  };
  const width = Math.round(positive(current.width, 0));
  const height = Math.round(positive(current.height, 0));
  const usable = width >= DEVTOOLS_MIN_WIDTH && height >= DEVTOOLS_MIN_HEIGHT;
  const left = Math.round(finite(current.left, browser.left));
  const top = Math.round(finite(current.top, browser.top));
  // Half of the toolbox has to be on the work area for a person to grab it.
  const onScreen =
    left + width / 2 > avail.left &&
    left + width / 2 < avail.left + avail.width &&
    top >= avail.top - 8 &&
    top + 24 < avail.top + avail.height;
  if (usable && onScreen) {
    return null;
  }
  // Never grow the toolbox beyond the display it is going on.
  const targetWidth = Math.min(
    Math.max(Math.round(browser.width * 0.72), 900),
    1400,
    avail.width,
  );
  const targetHeight = Math.min(
    Math.max(Math.round(browser.height * 0.62), 560),
    1000,
    avail.height,
  );
  const nextWidth = usable
    ? Math.min(width, avail.width)
    : Math.min(Math.max(width, targetWidth), avail.width);
  const nextHeight = usable
    ? Math.min(height, avail.height)
    : Math.min(Math.max(height, targetHeight), avail.height);
  // Centre it over the browser window, then keep it on the work area.
  return {
    left: clamp(
      browser.left + Math.round((browser.width - nextWidth) / 2),
      avail.left,
      avail.left + avail.width - nextWidth,
    ),
    top: clamp(
      browser.top + Math.round((browser.height - nextHeight) / 2),
      avail.top,
      avail.top + avail.height - nextHeight,
    ),
    width: nextWidth,
    height: nextHeight,
  };
}

/** The toolbox window this browser window's DevTools is in, if any. */
function toolboxWindow(win) {
  try {
    return win?.Services?.wm?.getMostRecentWindow?.("devtools:toolbox") ?? null;
  } catch {
    return null;
  }
}

/** When to re-check the toolbox window after it opens. A new toolbox window is
 *  reported by `Services.wm` before XUL has applied its persisted
 *  `width`/`height` and before the toolbox is loaded; a resize issued earlier
 *  is ignored or overwritten. The first open of a session also imports the
 *  DevTools modules, so the later ticks matter. */
export const DEVTOOLS_PLACEMENT_RETRY_MS = [
  0, 100, 200, 400, 700, 1100, 1600, 2400, 3400, 4600, 6000,
];

/**
 * Place the toolbox over a short settle window.
 *
 * One placement is not enough: the engine restores the toolbox window's own
 * persisted size as it opens, and ignores a resize until the window is loaded.
 * Each tick re-checks the live window and stops as soon as it is usable (or as
 * soon as the person already had a usable window, which is never touched).
 */
export function scheduleToolboxPlacement(
  win,
  attempts = DEVTOOLS_PLACEMENT_RETRY_MS,
) {
  const tick = (index) => {
    const toolbox = toolboxWindow(win);
    const loaded = !toolbox || toolbox.document?.readyState === "complete";
    if (toolbox && loaded && !placeToolboxWindow(win, toolbox)) {
      return;
    }
    if (index + 1 >= attempts.length) {
      return;
    }
    try {
      const timer = win?.setTimeout ?? setTimeout;
      timer(() => tick(index + 1), attempts[index + 1] - attempts[index]);
    } catch {
      // No timer on this window; a later call places it.
    }
  };
  tick(0);
}

/**
 * Give a freshly opened (or reused) toolbox window a size a person can work in.
 * Returns the rect it applied, or null when the window was already fine.
 */
export function placeToolboxWindow(win, toolbox = toolboxWindow(win)) {
  if (!toolbox || typeof toolbox.resizeTo !== "function") {
    return null;
  }
  const rect = devToolsWindowRect(win, {
    left: toolbox.screenX,
    top: toolbox.screenY,
    width: toolbox.outerWidth,
    height: toolbox.outerHeight,
  });
  if (!rect) {
    return null;
  }
  try {
    toolbox.resizeTo(rect.width, rect.height);
    if (typeof toolbox.moveTo === "function") {
      toolbox.moveTo(rect.left, rect.top);
    }
  } catch {
    // A window the OS refused to move is still a working toolbox.
    return null;
  }
  return rect;
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
export async function showDevTools(
  win,
  browser,
  toolId,
  { reason = "ContextMenu" } = {},
) {
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
    // The engine's toolbox window opens at its own 900x320 default and then
    // remembers that size, so the product's Inspect surface would otherwise be
    // a strip on every later open. Leave a usable size/position to the person.
    scheduleToolboxPlacement(win);
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
export function installContentMenu(
  win,
  { host, showMenu, isFromApp, tabIdOf },
) {
  const doc = win.document;
  const popup = doc.getElementById("contentAreaContextMenu");
  const fromApp = typeof isFromApp === "function" ? isFromApp : () => false;
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
    // A private window records nothing, and a bookmark is durable.
    if (isPrivateWindow(win)) return NOTHING;
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
              return win.Services.prefs.getStringPref(
                "astra.settings.split.link-target",
                "split",
              );
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
        case "image.save":
          menu.saveImage?.();
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
          const reply = await host.Peek.open({
            tab_id: id,
            source: "context-menu",
          });
          return { accepted: !reply?.error };
        }
        case "page.split": {
          const id = tabIdOf(browser);
          if (!id) return { accepted: false };
          const list = await host.Tabs.list({ request_id: "ctx-split" });
          const other = (list.tabs ?? []).find(
            (tab) => tab.astra_tab_id !== id && /^https?:/u.test(tab.url ?? ""),
          );
          let otherId = other?.astra_tab_id ?? "";
          if (!otherId) {
            // A split needs a second pane. From a single-tab window, put a
            // New Tab in the other pane so the action is visible and ready
            // for a drag.
            const made = await host.Tabs.create({
              request_id: "ctx-split-new",
              url: "about:blank",
              background: false,
            });
            otherId = made?.astra_tab_id ?? "";
          }
          if (!otherId) return { accepted: false };
          const reply = await host.SplitView.open({
            source: id,
            other: otherId,
          });
          return { accepted: !reply?.error, split: reply?.split === true };
        }
        case "page.copy":
          // The menu took focus from the page; the selection it was built for
          // is still the text the person meant to copy.
          copy(menu.selectedText);
          return NOTHING;
        case "page.cut":
          browser.focus?.();
          win.goDoCommand?.("cmd_cut");
          return NOTHING;
        case "page.paste":
          browser.focus?.();
          win.goDoCommand?.("cmd_paste");
          return NOTHING;
        case "page.selectAll":
          browser.focus?.();
          win.goDoCommand?.("cmd_selectAll");
          return NOTHING;
        case "page.search":
          return search(menu.selectedText);
        case "page.bookmark":
          return bookmark({
            url: browser.currentURI?.spec ?? "",
            title: browser.contentTitle ?? "",
          });
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
    const browser = menu?.browser ?? win.gBrowser?.selectedBrowser ?? null;
    if (!isContentBrowser(win, browser)) return;
    // A page can default-prevent its own contextmenu, or the engine can have
    // no model for this target. Native chrome must still not answer, and
    // returning here left the person with no menu at all: draw the generic
    // page menu from the browser instead.
    event.preventDefault();
    const { x, y } = screenPoint(win, menu?.contentData?.context);
    const model = menu?.shouldDisplay ? menu : {};
    current = { menu: model, browser };
    arm();
    if (typeof showMenu === "function") {
      showMenu({
        x,
        y,
        items: buildItems(model, browser),
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
    if (destroyed || !data || typeof data !== "object" || data.ns !== SHELL_NS)
      return;
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
    if (typeof win.OpenBrowserWindow === "function")
      return win.OpenBrowserWindow(options);
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
        const cur = await host.Windows.get({
          request_id: `win-${Date.now()}`,
          window_id: id,
        });
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
      // The host refuses `page.print` by name (no Astra print surface yet) and
      // never routes it here. Keeping a native print launch in the shell would
      // make an unreachable path that violates D-38 if it ever came back.
      return { accepted: false, reason: "unavailable" };
    case "page.viewSource":
      host.emit?.("ui-command", "browser.source");
      return { accepted: true };
    case "page.selectAll":
    case "page.copy":
    case "page.cut":
    case "page.paste": {
      // The chrome shortcut arrives after focus left the page. Put it back
      // before the engine command, or it copies the menu instead of the page.
      try {
        browser?.focus?.();
      } catch {
        // The page may have gone; the command is still the honest attempt.
      }
      const command =
        id === "page.selectAll"
          ? "cmd_selectAll"
          : id === "page.cut"
            ? "cmd_cut"
            : id === "page.paste"
              ? "cmd_paste"
              : "cmd_copy";
      win.goDoCommand?.(command);
      return { accepted: true };
    }
    case "bookmark.current":
    case "bookmark.add": {
      if (isPrivateWindow(win)) return { accepted: false };
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
