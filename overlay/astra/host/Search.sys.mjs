/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Search module (wiring). One place decides what the person meant
// when they typed into a search box: an address, or words for the engine they
// chose. The New Tab field, the launcher and the address bar all ask here, so
// they cannot disagree about it.
//
// Security posture:
//   - An engine is an https URL template. The table below is fixed; a custom
//     engine is accepted only when it is https and carries `%s`, so the field
//     can never be pointed at a plain-http, javascript:, data: or file: URL.
//   - The query is percent-encoded exactly once, by encodeURIComponent, so it
//     cannot add parameters, change the host, or break out of the template.
//   - Typed text only becomes a navigation when it is http, https or the one
//     inert about: page. javascript:, data:, file:, chrome:, resource: and
//     every privileged about: page typed by hand are searched for instead of
//     run, the way the address bar has always been expected to behave.
//   - Nothing is sent anywhere to suggest: no suggestion provider is wired,
//     so keystrokes stay in this process until the person presses Enter.
//
// Pure logic, no Firefox internals.

import { Settings } from "./Settings.sys.mjs";
import { emit } from "./Events.sys.mjs";

/** Engines by the id `search.engine` stores. Every URL is https. */
const ENGINES = {
  duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s" },
  google: { name: "Google", url: "https://www.google.com/search?q=%s" },
  bing: { name: "Bing", url: "https://www.bing.com/search?q=%s" },
  brave: { name: "Brave Search", url: "https://search.brave.com/search?q=%s" },
  startpage: { name: "Startpage", url: "https://www.startpage.com/sp/search?query=%s" },
  ecosia: { name: "Ecosia", url: "https://www.ecosia.org/search?q=%s" },
  mojeek: { name: "Mojeek", url: "https://www.mojeek.com/search?q=%s" },
  wikipedia: { name: "Wikipedia", url: "https://en.wikipedia.org/w/index.php?search=%s" },
};

const DEFAULT_ENGINE = "duckduckgo";

/** Schemes a typed address may use. Everything else is searched for. */
const NAVIGABLE = new Set(["http:", "https:"]);

/**
 * The one internal page a typed address may reach. A blank document carries no
 * privileges; about:config, about:debugging, about:addons and their kin are
 * system-principal pages, and pointing a content browser at one relies on the
 * engine refusing the load. Fail closed: every other about: address is words,
 * as javascript: and data: already are.
 */
function isBlankAbout(parsed) {
  return parsed.protocol === "about:" && parsed.pathname === "blank" && parsed.host === "";
}

function engineSetting() {
  const id = Settings.current("search.engine");
  return typeof id === "string" && id !== "" ? id : DEFAULT_ENGINE;
}

function customTemplate() {
  const url = Settings.current("search.custom-url");
  return typeof url === "string" ? url.trim() : "";
}

/** The engine in use: a custom https template when one is set and safe,
 *  otherwise the chosen built-in, otherwise DuckDuckGo. */
export function engine() {
  const custom = customTemplate();
  if (custom !== "") {
    try {
      const parsed = new URL(custom.replace("%s", "x"));
      if (parsed.protocol === "https:" && custom.includes("%s")) {
        return { id: "custom", name: parsed.hostname, url: custom };
      }
    } catch {
      // Not a URL: fall through to the built-in table.
    }
  }
  const chosen = ENGINES[engineSetting()];
  return chosen
    ? { id: engineSetting(), ...chosen }
    : { id: DEFAULT_ENGINE, ...ENGINES[DEFAULT_ENGINE] };
}

/** The URL a query searches for, on the engine in use. */
export function searchUrl(query) {
  const text = String(query ?? "").trim();
  if (text === "") return null;
  const template = engine().url;
  // The template is validated above; encode once, into the placeholder.
  return template.replace("%s", encodeURIComponent(text));
}

/**
 * What the typed text means: a `url` to load, or `search` words for the
 * engine. `null` for nothing worth navigating to.
 */
export function resolve(input) {
  const text = String(input ?? "").trim();
  if (text === "") return null;
  // A development host is an address, not a scheme. `localhost:3000` and
  // `127.0.0.1:8080` are what a person types most often that look like
  // `scheme:port`; a loopback server is http, anything else keeps https.
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[/?#][^\s]*)?$/iu;
  if (loopback.test(text)) {
    return { kind: "url", url: new URL(`http://${text}`).href };
  }
  const hostPort = /^[^\s/:]+\.[^\s/:]+:\d{1,5}(?:[/?#][^\s]*)?$/iu;
  if (hostPort.test(text)) {
    return { kind: "url", url: new URL(`https://${text}`).href };
  }
  // A scheme the address bar may run.
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    try {
      const parsed = new URL(text);
      if (NAVIGABLE.has(parsed.protocol) || isBlankAbout(parsed)) {
        return { kind: "url", url: parsed.href };
      }
    } catch {
      // A colon that is not a scheme ("10:30", "note: buy milk") is a search.
    }
    // Anything else typed with a scheme is words, not a navigation.
    return { kind: "search", url: searchUrl(text), query: text };
  }
  // A bare host reads as an address; a word does not.
  if (/^[^\s/]+\.[^\s/]+/.test(text) && !text.includes(" ")) {
    try {
      return { kind: "url", url: new URL(`https://${text}`).href };
    } catch {
      // Fall through: it was not a host after all.
    }
  }
  return { kind: "search", url: searchUrl(text), query: text };
}

function result(kind, title, detail, action) {
  return { kind, title, detail, icon: null, action };
}

export const Search = {
  /** The engine the boxes name, for their placeholder and their rows. */
  async engineInfo() {
    const current = engine();
    return { id: current.id, name: current.name };
  },

  /** What a submitted field would do, without doing it. */
  async resolve({ input = "" } = {}) {
    return resolve(input);
  },

  /**
   * The New Tab field's context: who is asking, so a late answer for an old
   * query can be dropped instead of painting over a newer one.
   */
  async newtabContext({ tabId = "" } = {}) {
    return {
      window_id: "win-1",
      session_id: `newtab:${String(tabId || "tab")}`,
      request_id: "",
      profile_id: "default",
      space_id: "space-1",
    };
  },

  /**
   * Answer a New Tab query with the one row that matters: search the web for
   * exactly what was typed. No remote suggestion provider is asked, so the
   * keystrokes never leave the process.
   */
  async newtabSearch({ query = "", context = null } = {}) {
    const text = String(query ?? "").trim();
    const owner = context ?? (await Search.newtabContext({}));
    const current = engine();
    const url = text === "" ? null : searchUrl(text);
    emit("search-changed", {
      pending: false,
      context: { ...owner, request_id: owner.request_id ?? "" },
      query: text,
      completion: null,
      results: url
        ? [result("search", text, `Search ${current.name}`, { type: "OpenUrl", url })]
        : [],
    });
    return true;
  },

  /** Run the row the person picked. */
  async newtabRun({ action = null, context = null } = {}) {
    const owner = context ?? (await Search.newtabContext({}));
    if (!action || action.type !== "OpenUrl" || typeof action.url !== "string") {
      return { operation_id: null, accepted: false };
    }
    // A row's URL is an address, never words: a javascript:/data: row is
    // refused outright instead of being turned into a search.
    const resolved = resolve(action.url);
    if (!resolved || resolved.kind !== "url") return { operation_id: null, accepted: false };
    const { Tabs, __tabsState } = await import("./Tabs.sys.mjs");
    const { Navigation } = await import("./Navigation.sys.mjs");
    const tab = __tabsState().selectedId;
    if (tab) {
      await Navigation.loadURL({ astra_tab_id: tab, url: resolved.url });
      return { operation_id: null, accepted: true };
    }
    await Tabs.create({ url: resolved.url, background: false });
    return { operation_id: null, accepted: true };
  },

  async newtabCancel() {
    return true;
  },

  /** `browser_open_url`: the window has no page to type into, so the address
   *  goes to a tab — the same resolution, so search works there too. */
  async openUrl({ url = "", new_tab = false } = {}) {
    const resolved = resolve(url);
    if (!resolved) return { operation_id: null, accepted: false };
    const { Tabs, __tabsState } = await import("./Tabs.sys.mjs");
    const { Navigation } = await import("./Navigation.sys.mjs");
    const tab = new_tab ? "" : __tabsState().selectedId;
    if (tab) {
      const result = await Navigation.loadURL({ astra_tab_id: tab, url: resolved.url });
      return { operation_id: null, accepted: !result.error };
    }
    await Tabs.create({ url: resolved.url, background: false });
    return { operation_id: null, accepted: true };
  },

  /**
   * The launcher's query. Local results belong to native; the only row this
   * module adds is the web search for what was typed, so the launcher can
   * always hand the words to the engine.
   */
  async launcherSearch({ query = "", requestId = "" } = {}) {
    const text = String(query ?? "").trim();
    const current = engine();
    const url = text === "" ? null : searchUrl(text);
    emit("search-changed", {
      pending: false,
      context: null,
      query: text,
      completion: null,
      results: url
        ? [result("search", text, `Search ${current.name}`, { type: "OpenUrl", url })]
        : [],
    });
    void requestId;
    return true;
  },

  /** Run a launcher row (the launcher's own results are native's). */
  async launcherRun({ action = null } = {}) {
    if (!action || action.type !== "OpenUrl" || typeof action.url !== "string") {
      return { operation_id: null, accepted: false };
    }
    // A row's URL is an address, never words: a javascript:/data: row is
    // refused outright instead of being turned into a search.
    const resolved = resolve(action.url);
    if (!resolved || resolved.kind !== "url") return { operation_id: null, accepted: false };
    const { Tabs, __tabsState } = await import("./Tabs.sys.mjs");
    const { Navigation } = await import("./Navigation.sys.mjs");
    const tab = __tabsState().selectedId;
    if (tab) {
      await Navigation.loadURL({ astra_tab_id: tab, url: resolved.url });
      return { operation_id: null, accepted: true };
    }
    await Tabs.create({ url: resolved.url, background: false });
    return { operation_id: null, accepted: true };
  },
};

export function __engines() {
  return Object.keys(ENGINES);
}
