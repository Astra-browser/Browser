/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Peek module: a real page preview owned by Astra's interface.
//
// A peek is a bounded, transient projection: the target tab's URL/title, one
// capture of what the page actually renders, and a timestamp. The engine's own
// tab-hover panel never shows; the app draws the card from `peek-changed`.
//
// Captures use the engine's `PageThumbs.captureTabPreviewThumbnail` on the
// live browser (a snapshot draw, not a second page load), then the canvas is
// released immediately. A URL that is not open falls back to the stored page
// thumbnail URL; there is never a hidden live `<browser>` per peek.
//
// State is per window. The relay stamps `window_id` on every call; a private
// window's cards never enter another window's map, never reach the session
// pref, and never appear in `peek-changed` for another window. The event is a
// small change notice; the UI re-reads `peek_list`, so a data URL never sits
// in the event ring buffer.
//
// At most MAX_PEEKS cards live in one window. A per-id epoch makes a capture
// that finishes after its card was closed harmless.

import { emit } from "./Events.sys.mjs";
import { HOST_API_VERSION } from "./Tabs.sys.mjs";
import { SplitView, __nativeBinding } from "./SplitView.sys.mjs";

const XHTML_NS = "http://www.w3.org/1999/xhtml";
export const MAX_PEEKS = 4;
export const CAPTURE_WIDTH = 640;
export const CAPTURE_HEIGHT = 400;
export const SESSION_PREF = "astra.peek.session.v1";
export const CONFIG_PREF = "astra.peek.config.v1";
const CONFIG_KEYS = new Set([
  "enabled",
  "trigger",
  "delay",
  "size",
  "position",
  "scale",
  "restore",
  "closeOnLeave",
  "showUrl",
  "showTitle",
]);

const _peeks = new Map(); // window_id -> Map(peek id -> record)
const _epochs = new Map(); // peek id -> number

function ok(request_id, data = {}) {
  return { request_id, host_api_version: HOST_API_VERSION, ...data };
}

function err(request_id, code, message) {
  return { request_id, host_api_version: HOST_API_VERSION, error: { code, message } };
}

function services() {
  try {
    return globalThis.Services ?? null;
  } catch {
    return null;
  }
}

/** The binding is the single source of the caller's window and privacy. */
function bindingFor(window_id = "") {
  return __nativeBinding(window_id);
}

function currentWindow(window_id = "") {
  return bindingFor(window_id)?.win ?? null;
}

function windowKey(window_id = "") {
  return bindingFor(window_id)?.window_id ?? "";
}

function peeksFor(window_id = "", create = false) {
  const key = windowKey(window_id);
  if (!key) return null;
  let map = _peeks.get(key);
  if (!map && create) {
    map = new Map();
    _peeks.set(key, map);
  }
  return map ?? null;
}

function isPrivateWindow(win) {
  try {
    if (win?.PrivateBrowsingUtils?.isWindowPrivate?.(win) === true) return true;
  } catch {
    // Fall through.
  }
  try {
    const CU = globalThis.ChromeUtils;
    if (CU) {
      const { PrivateBrowsingUtils } = CU.importESModule(
        "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
      );
      if (PrivateBrowsingUtils.isWindowPrivate(win) === true) return true;
    }
  } catch {
    // Fall through to the document marker.
  }
  try {
    return win?.document?.documentElement?.getAttribute("privatebrowsingmode") === "temporary";
  } catch {
    return false;
  }
}

function prefString(name, fallback) {
  try {
    return services()?.prefs?.getStringPref(name, fallback) ?? fallback;
  } catch {
    return fallback;
  }
}

function prefBool(name, fallback) {
  try {
    const prefs = services()?.prefs;
    if (!prefs) return fallback;
    const raw = prefs.getStringPref(name, "");
    if (raw === "true") return true;
    if (raw === "false") return false;
    return prefs.getBoolPref(name, fallback);
  } catch {
    return fallback;
  }
}

/** The Astra setting names owned by the Peek category. */
export function defaultConfig() {
  return {
    enabled: true,
    trigger: "hover-shift",
    delay: 420,
    size: "medium",
    position: "auto",
    scale: 1,
    restore: true,
    closeOnLeave: true,
    showUrl: true,
    showTitle: true,
  };
}

export function readConfig() {
  const base = defaultConfig();
  base.enabled = prefBool("astra.settings.peek.enabled", base.enabled);
  base.trigger = prefString("astra.settings.peek.trigger", base.trigger);
  base.size = prefString("astra.settings.peek.size", base.size);
  base.position = prefString("astra.settings.peek.position", base.position);
  base.restore = prefBool("astra.settings.peek.restore", base.restore);
  base.closeOnLeave = prefBool("astra.settings.peek.close-leave", base.closeOnLeave);
  base.showUrl = prefBool("astra.settings.peek.show-url", base.showUrl);
  base.showTitle = prefBool("astra.settings.peek.show-title", base.showTitle);
  const delay = Number(prefString("astra.settings.peek.delay", String(base.delay)));
  if (Number.isFinite(delay) && delay >= 0) base.delay = delay;
  const scale = Number(prefString("astra.settings.peek.scale", String(base.scale)));
  if (Number.isFinite(scale) && scale > 0) base.scale = scale;
  return base;
}

function writeConfig(next) {
  try {
    const prefs = services()?.prefs;
    if (!prefs) return false;
    const mapping = {
      enabled: "enabled",
      trigger: "trigger",
      delay: "delay",
      size: "size",
      position: "position",
      scale: "scale",
      restore: "restore",
      closeOnLeave: "close-leave",
      showUrl: "show-url",
      showTitle: "show-title",
    };
    for (const [key, name] of Object.entries(mapping)) {
      if (!(key in next)) continue;
      prefs.setStringPref(`astra.settings.peek.${name}`, String(next[key]));
    }
    return true;
  } catch {
    return false;
  }
}

/** Validate one peek target. Pure, exported for tests. */
export function validTarget({ tab_id = "", url = "" } = {}) {
  if (typeof tab_id === "string" && tab_id !== "") return { tab_id, url: "" };
  if (typeof url !== "string" || url === "") return null;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return { tab_id: "", url: parsed.href };
  } catch {
    return null;
  }
}

/** Stable card identity: one per tab, or one per URL. Pure, exported. */
export function peekId(target) {
  if (!target) return "";
  if (target.tab_id) return `tab:${target.tab_id}`;
  return `url:${target.url}`;
}

/** Keep the newest MAX_PEEKS records. Pure, exported for tests. */
export function trimPeeks(records, max = MAX_PEEKS) {
  const rows = [...records];
  rows.sort((a, b) => (a.captured_at ?? 0) - (b.captured_at ?? 0));
  while (rows.length > max) rows.shift();
  return rows;
}

function tabByAstraId(win, id) {
  if (!win?.gBrowser || typeof id !== "string" || id === "") return null;
  return win.gBrowser.tabs.find((tab) => tab.getAttribute("astra-tab-id") === id) ?? null;
}

async function thumbnailForUrl(win, url) {
  try {
    const CU = win?.ChromeUtils ?? globalThis.ChromeUtils;
    if (!CU) return null;
    const { PageThumbs } = CU.importESModule("resource://gre/modules/PageThumbs.sys.mjs");
    return PageThumbs.getThumbnailURL(url) ?? null;
  } catch {
    return null;
  }
}

/**
 * Capture the live page into a bounded PNG data URL. The canvas is released
 * even when the draw throws, so a failed preview leaves no backing store.
 */
async function captureTab(win, tab) {
  const browser = tab?.linkedBrowser ?? null;
  if (!browser) return null;
  let canvas = null;
  try {
    canvas = win.document.createElementNS(XHTML_NS, "canvas");
    canvas.width = CAPTURE_WIDTH;
    canvas.height = CAPTURE_HEIGHT;
    const CU = win.ChromeUtils ?? globalThis.ChromeUtils;
    const { PageThumbs } = CU.importESModule("resource://gre/modules/PageThumbs.sys.mjs");
    await PageThumbs.captureTabPreviewThumbnail(browser, canvas);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  } finally {
    if (canvas) {
      try {
        canvas.width = 0;
        canvas.height = 0;
      } catch {
        // A torn-down document.
      }
    }
  }
}

function snapshot(window_id = "") {
  const map = peeksFor(window_id);
  return {
    peeks: map ? [...map.values()].map((peek) => ({ ...peek })) : [],
    config: readConfig(),
    private: isPrivateWindow(currentWindow(window_id)),
  };
}

/** A small change notice; captures never enter the event ring buffer. */
function publish(window_id = "") {
  const key = windowKey(window_id);
  if (!key) return;
  emit("peek-changed", { window_id: key, changed: true });
}

function saveSession() {
  // Merge every normal window's cards into one profile-scoped session. Private
  // windows have records in their own map only, but filter again here.
  const rows = [];
  for (const map of _peeks.values()) {
    for (const peek of map.values()) {
      if (peek.private || !peek.url) continue;
      rows.push({
        id: peek.id,
        tab_id: peek.tab_id,
        url: peek.url,
        title: peek.title,
        space_id: peek.space_id,
        captured_at: peek.captured_at,
      });
    }
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  try {
    services()?.prefs?.setStringPref(
      SESSION_PREF,
      JSON.stringify([...byId.values()].slice(-MAX_PEEKS)),
    );
  } catch {
    // A closed profile or a private window keeps nothing.
  }
}

function readSession() {
  try {
    const parsed = JSON.parse(prefString(SESSION_PREF, "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function bump(id) {
  const next = (_epochs.get(id) ?? 0) + 1;
  _epochs.set(id, next);
  return next;
}

export const Peek = {
  /** Open or refresh one peek. A tab id is preferred; a URL is the fallback. */
  async open({ request_id = "", tab_id = "", url = "", title = "", source = "manual", window_id = "" } = {}) {
    const config = readConfig();
    if (!config.enabled) return err(request_id, "disabled", "peeks are turned off");
    const win = currentWindow(window_id);
    if (!win) return err(request_id, "no_window", "no chrome window is available");
    const privateWindow = isPrivateWindow(win);
    let target = validTarget({ tab_id, url });
    let tab = target?.tab_id ? tabByAstraId(win, target.tab_id) : null;
    if (!target) return err(request_id, "invalid_target", "a preview needs a tab or an http(s) URL");
    if (target.tab_id && !tab) return err(request_id, "no_such_tab", "that tab is gone");
    let resolvedUrl = target.url;
    let resolvedTitle = typeof title === "string" ? title.slice(0, 300) : "";
    let spaceId = "";
    if (tab) {
      try {
        resolvedUrl = tab.linkedBrowser?.currentURI?.spec ?? "";
        resolvedTitle = (resolvedTitle || tab.label || tab.linkedBrowser?.contentTitle || resolvedUrl).slice(0, 300);
      } catch {
        resolvedUrl = resolvedUrl ?? "";
      }
      try {
        spaceId = tab.getAttribute("astra-space-id") || "";
      } catch {
        spaceId = "";
      }
      if (!/^https?:/u.test(resolvedUrl)) {
        return err(request_id, "not_previewable", "internal pages have no page preview");
      }
      target = { tab_id: target.tab_id, url: resolvedUrl };
    }
    const id = peekId(target);
    const epoch = bump(id);
    const image = tab ? await captureTab(win, tab) : null;
    if ((_epochs.get(id) ?? 0) !== epoch) {
      // A newer open or a close superseded this capture.
      return ok(request_id, { id, stale: true });
    }
    const thumbnail = image ? null : await thumbnailForUrl(win, resolvedUrl);
    const record = {
      id,
      tab_id: target.tab_id,
      url: resolvedUrl,
      title: resolvedTitle || resolvedUrl,
      space_id: spaceId,
      source,
      private: privateWindow,
      captured_at: Date.now(),
      image,
      thumbnail,
    };
    const map = peeksFor(window_id, true);
    if (!map) return err(request_id, "no_window", "no chrome window is available");
    map.set(id, record);
    if (map.size > MAX_PEEKS) {
      const oldest = trimPeeks([...map.values()]).slice(0, map.size - MAX_PEEKS);
      for (const stale of oldest) {
        map.delete(stale.id);
        bump(stale.id);
      }
    }
    if (!privateWindow) saveSession();
    publish(window_id);
    return ok(request_id, { id, peek: record });
  },

  async close({ request_id = "", id = "", window_id = "" } = {}) {
    const map = peeksFor(window_id);
    const had = map?.delete(id) === true;
    bump(id);
    if (had) {
      const win = currentWindow(window_id);
      if (!isPrivateWindow(win)) saveSession();
      publish(window_id);
    }
    return ok(request_id, { closed: had });
  },

  async closeAll({ request_id = "", window_id = "" } = {}) {
    const map = peeksFor(window_id);
    const count = map?.size ?? 0;
    if (map) {
      for (const id of map.keys()) bump(id);
      map.clear();
    }
    publish(window_id);
    const win = currentWindow(window_id);
    if (!isPrivateWindow(win)) saveSession();
    return ok(request_id, { closed: count });
  },

  async capture({ request_id = "", id = "", window_id = "" } = {}) {
    const peek = peeksFor(window_id)?.get(id);
    if (!peek) return err(request_id, "no_such_peek", "unknown preview");
    const win = currentWindow(window_id);
    const tab = peek.tab_id ? tabByAstraId(win, peek.tab_id) : null;
    const image = tab ? await captureTab(win, tab) : null;
    peek.image = image;
    peek.captured_at = Date.now();
    publish(window_id);
    return ok(request_id, { captured: image !== null });
  },

  async list({ request_id = "", window_id = "" } = {}) {
    return ok(request_id, snapshot(window_id));
  },

  /** Open the peek's page as a normal tab in the same window. */
  async openTab({ request_id = "", id = "", window_id = "" } = {}) {
    const peek = peeksFor(window_id)?.get(id);
    if (!peek) return err(request_id, "no_such_peek", "unknown preview");
    const reply = await SplitView.openUrl({ url: peek.url, mode: "tab", window_id });
    if (reply?.error) return err(request_id, reply.error.code, reply.error.message);
    peeksFor(window_id)?.delete(id);
    bump(id);
    const win = currentWindow(window_id);
    if (!isPrivateWindow(win)) saveSession();
    publish(window_id);
    return ok(request_id, { opened: true, astra_tab_id: reply.astra_tab_id });
  },

  /** Open the peek's page beside the front tab as a native split pane. */
  async openSplit({ request_id = "", id = "", window_id = "" } = {}) {
    const peek = peeksFor(window_id)?.get(id);
    if (!peek) return err(request_id, "no_such_peek", "unknown preview");
    const reply = await SplitView.openUrl({ url: peek.url, mode: "split", placement: "right", window_id });
    if (reply?.error) return err(request_id, reply.error.code, reply.error.message);
    peeksFor(window_id)?.delete(id);
    bump(id);
    const win = currentWindow(window_id);
    if (!isPrivateWindow(win)) saveSession();
    publish(window_id);
    return ok(request_id, { opened: true, split: reply.split === true });
  },

  /** Restore cards saved before a restart (opt-in, never in private). */
  async restore({ request_id = "", window_id = "" } = {}) {
    const config = readConfig();
    if (!config.enabled || !config.restore) return ok(request_id, { restored: 0 });
    const win = currentWindow(window_id);
    if (!win || isPrivateWindow(win)) return ok(request_id, { restored: 0 });
    const map = peeksFor(window_id, true);
    if (!map) return ok(request_id, { restored: 0 });
    const rows = readSession();
    let restored = 0;
    for (const row of rows.slice(-MAX_PEEKS)) {
      if (!row || typeof row.url !== "string" || !row.url) continue;
      if (!validTarget({ url: row.url })) continue;
      const tab = row.tab_id ? tabByAstraId(win, row.tab_id) : null;
      const id = peekId({ tab_id: row.tab_id, url: row.url });
      const epoch = bump(id);
      const image = tab ? await captureTab(win, tab) : null;
      if ((_epochs.get(id) ?? 0) !== epoch) continue;
      map.set(id, {
        id,
        tab_id: row.tab_id ?? "",
        url: row.url,
        title: typeof row.title === "string" ? row.title.slice(0, 300) : row.url,
        space_id: typeof row.space_id === "string" ? row.space_id : "",
        source: "restore",
        private: false,
        captured_at: Number.isFinite(row.captured_at) ? row.captured_at : Date.now(),
        image,
        thumbnail: image ? null : await thumbnailForUrl(win, row.url),
      });
      restored += 1;
    }
    if (restored > 0) publish(window_id);
    return ok(request_id, { restored });
  },

  async configure({ request_id = "", config = {}, window_id = "" } = {}) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return err(request_id, "invalid", "config must be an object");
    }
    const next = readConfig();
    for (const [key, value] of Object.entries(config)) {
      if (!CONFIG_KEYS.has(key)) continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        next[key] = value;
      }
    }
    if (!writeConfig(next)) {
      return err(request_id, "store_failed", "the peek configuration could not be saved");
    }
    publish(window_id);
    return ok(request_id, { config: readConfig() });
  },
};

export function __resetPeekForTests() {
  _peeks.clear();
  _epochs.clear();
}
