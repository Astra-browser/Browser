/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Search module (wiring). One place decides what the person meant
// when they typed into a search box: an address, words for the engine they
// chose, or a `!bang` for one named engine. The New Tab field, the launcher
// and the address bar all ask here, so they cannot disagree about it.
//
// Security posture:
//   - An engine is an https URL template. The table below is fixed; a custom
//     engine is accepted only when it is https and carries one placeholder,
//     either `%s` or `{searchTerms}`, so the field can never be pointed at a
//     plain-http, javascript:, data: or file: URL. The two spellings are
//     normalised to `%s` once, at the edge.
//   - The query is percent-encoded exactly once, by encodeURIComponent, so it
//     cannot add parameters, change the host, or break out of the template.
//   - Typed text only becomes a navigation when it is http, https or the one
//     inert about: page. javascript:, data:, file:, chrome:, resource: and
//     every privileged about: page typed by hand are searched for instead of
//     run, the way the address bar has always been expected to behave.
//   - Suggestions are opt-in (`search.suggestions`), sent only to the engine
//     the field is about to search with, without cookies, and dropped when a
//     newer request id replaces them. A failed or empty fetch contributes no
//     row; it never invents a suggestion.
//
// Pure logic, no Firefox internals.

import { Settings } from "./Settings.sys.mjs";
import { emit } from "./Events.sys.mjs";
// Pure model modules; importing them here (rather than a dynamic `import()`
// on the click path) keeps a typed search on the same footing as the address
// bar's direct navigation. Navigation imports `resolve` from this module, so
// this is a call-time cycle: neither side touches the other at module load.
import { Tabs, __tabsState } from "./Tabs.sys.mjs";
import { Navigation } from "./Navigation.sys.mjs";

/** Engines by the id `search.engine` stores. Every URL is https. */
const ENGINES = {
  duckduckgo: {
    name: "DuckDuckGo",
    url: "https://duckduckgo.com/?q=%s",
    suggest: "https://duckduckgo.com/ac/?q=%s&type=list",
  },
  google: {
    name: "Google",
    url: "https://www.google.com/search?q=%s",
    suggest: "https://suggestqueries.google.com/complete/search?client=chrome&q=%s",
  },
  bing: {
    name: "Bing",
    url: "https://www.bing.com/search?q=%s",
    suggest: "https://www.bing.com/osjson.aspx?query=%s",
  },
  brave: {
    name: "Brave Search",
    url: "https://search.brave.com/search?q=%s",
    suggest: "https://search.brave.com/api/suggest?q=%s",
  },
  startpage: { name: "Startpage", url: "https://www.startpage.com/sp/search?query=%s" },
  ecosia: { name: "Ecosia", url: "https://www.ecosia.org/search?q=%s" },
  mojeek: { name: "Mojeek", url: "https://www.mojeek.com/search?q=%s" },
  wikipedia: { name: "Wikipedia", url: "https://en.wikipedia.org/w/index.php?search=%s" },
};

// Google serves an image CAPTCHA to fresh/automated profiles; Astra does not
// bypass a CAPTCHA. A privacy-first engine is the default, and Google stays a
// selectable engine when the person chooses it.
const DEFAULT_ENGINE = "duckduckgo";

/** Leading `!` shortcuts, parsed before URL detection. */
const BANGS = {
  g: "google",
  d: "duckduckgo",
  b: "bing",
  br: "brave",
};

/** A burst of typing is one request; the surface already coalesces, so this
 *  only keeps the host from starting a fetch for a request already replaced. */
const SUGGEST_DEBOUNCE_MS = 80;
const SUGGEST_TIMEOUT_MS = 1200;
const SUGGEST_LIMIT = 5;

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

/** Normalise the two placeholder spellings to the one host uses, exactly once.
 *  Two placeholders (or a mix) are ambiguous and refused. */
export function normaliseSearchTemplate(value) {
  const text = String(value ?? "").trim();
  if (text === "") return null;
  const tokens = text.match(/%s|\{searchTerms\}/gu) ?? [];
  if (tokens.length !== 1) return null;
  return text.replace("{searchTerms}", "%s");
}

/** The engine in use: a custom https template when one is set and safe,
 *  otherwise the chosen built-in, otherwise Google. */
export function engine() {
  const custom = customTemplate();
  const template = normaliseSearchTemplate(custom);
  if (template !== null) {
    try {
      const parsed = new URL(template.replace("%s", "x"));
      if (parsed.protocol === "https:") {
        return { id: "custom", name: parsed.hostname, url: template, suggest: null };
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

/** The URL a query searches for on one named built-in engine. */
export function searchUrlFor(engineId, query) {
  const text = String(query ?? "").trim();
  const chosen = ENGINES[engineId];
  if (text === "" || !chosen) return null;
  return chosen.url.replace("%s", encodeURIComponent(text));
}

/** The URL a query searches for, on the engine in use. */
export function searchUrl(query) {
  const text = String(query ?? "").trim();
  if (text === "") return null;
  // The template is validated above; encode once, into the placeholder.
  return engine().url.replace("%s", encodeURIComponent(text));
}

/** A leading `!g` / `!d` / `!b` / `!br` overrides the selected engine. It is
 *  read before URL detection, so `!g example.com` searches rather than opening
 *  the host. A bang with no words is not a command and falls through. */
export function bang(input) {
  const text = String(input ?? "").trim();
  const match = /^!([a-z]+)(?:\s+|$)([\s\S]*)$/iu.exec(text);
  if (!match) return null;
  const engineId = BANGS[match[1].toLowerCase()];
  const query = match[2].trim();
  if (!engineId || query === "") return null;
  return { engine: engineId, query };
}

/**
 * What the typed text means: a `url` to load, or `search` words for the
 * engine. `null` for nothing worth navigating to.
 */
export function resolve(input) {
  const text = String(input ?? "").trim();
  if (text === "") return null;
  const override = bang(text);
  if (override) {
    return {
      kind: "search",
      url: searchUrlFor(override.engine, override.query),
      query: override.query,
    };
  }
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

function searchRow(text, current) {
  return result("search", text, `Search ${current.name}`, {
    type: "OpenUrl",
    url: searchUrl(text),
  });
}

function suggestionRow(suggestion, current) {
  return result("suggestion", suggestion, current.name, {
    type: "OpenUrl",
    url: searchUrlFor(current.id, suggestion),
  });
}

function suggestionsEnabled() {
  // The native pref defaults to on; only an explicit "false" silences it.
  return Settings.current("search.suggestions") !== "false";
}

function chromeGlobal() {
  try {
    return globalThis.window ?? globalThis.document?.defaultView ?? globalThis;
  } catch {
    return globalThis;
  }
}

/** The engine's own suggest endpoint, when the local table declares one. */
function tableSuggestUrl(current, text) {
  if (current.id === "custom" || typeof current.suggest !== "string") return null;
  return current.suggest.replace("%s", encodeURIComponent(text));
}

/** The search service knows the engine's OpenSearch suggestion URL. Use it
 *  when the selected engine is the browser's default engine, so suggestions
 *  come from the same provider that would answer the search. */
function searchServiceSuggestUrl(current, text) {
  try {
    if (current.id === "custom") return null;
    const search = (chromeGlobal().Services ?? globalThis.Services)?.search;
    const selected = search?.defaultEngine;
    if (!selected || selected.name !== current.name) return null;
    const submission = selected.getSubmission(text, "application/x-suggestions+json");
    const spec = submission?.uri?.spec;
    return typeof spec === "string" && /^https:/iu.test(spec) ? spec : null;
  } catch {
    return null;
  }
}

function suggestUrl(current, text) {
  return searchServiceSuggestUrl(current, text) ?? tableSuggestUrl(current, text);
}

/**
 * Parse the two shapes the shipped engines use: an OpenSearch JSON array
 * (`[query, [suggestions], ...]`) and a JSON object with `suggestions`.
 * Anything else, a non-string entry, the typed query itself, duplicates, or a
 * row past the limit is dropped.
 */
export function parseSuggestions(payload, query = "") {
  let data;
  try {
    data = JSON.parse(String(payload ?? ""));
  } catch {
    return [];
  }
  const values = [];
  const add = (value) => {
    if (typeof value === "string") {
      values.push(value);
      return;
    }
    if (Array.isArray(value) && typeof value[0] === "string") {
      values.push(value[0]);
      return;
    }
    if (value !== null && typeof value === "object") {
      const text = value.phrase ?? value.suggestion ?? value.query ?? value.value;
      if (typeof text === "string") values.push(text);
    }
  };
  if (Array.isArray(data)) {
    if (Array.isArray(data[1])) {
      for (const entry of data[1]) add(entry);
    } else if (Array.isArray(data[0])) {
      // DuckDuckGo's `type=list` variant.
      for (const entry of data[0]) add(entry);
    }
  } else if (data !== null && typeof data === "object") {
    const list = data.suggestions ?? data[1] ?? data.items;
    if (Array.isArray(list)) {
      for (const entry of list) add(entry);
    }
  }
  const seen = new Set();
  const typed = String(query ?? "").trim().toLowerCase();
  const out = [];
  for (const raw of values) {
    const text = raw.trim();
    const key = text.toLowerCase();
    if (text === "" || key === typed || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= SUGGEST_LIMIT) break;
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchFunction() {
  const scope = chromeGlobal();
  if (typeof scope.fetch === "function") return scope.fetch.bind(scope);
  if (typeof globalThis.fetch === "function") return globalThis.fetch.bind(globalThis);
  try {
    const services = (scope.Services ?? globalThis.Services);
    const win = services?.wm?.getMostRecentWindow?.("navigator:browser");
    if (typeof win?.fetch === "function") return win.fetch.bind(win);
  } catch {
    // No window: outside a browser there is no provider.
  }
  return null;
}

/**
 * One suggestion request. Returns `null` when a newer request replaced it, and
 * `[]` when the provider failed, answered non-2xx or had nothing. It never
 * fabricates a row.
 */
async function fetchSuggestions(text, current, stillCurrent) {
  const url = suggestUrl(current, text);
  const doFetch = fetchFunction();
  if (url === null || doFetch === null) return [];
  await sleep(SUGGEST_DEBOUNCE_MS);
  if (!stillCurrent()) return null;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), SUGGEST_TIMEOUT_MS);
  try {
    const response = await doFetch(url, {
      signal: controller?.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!stillCurrent()) return null;
    if (!response?.ok) return [];
    const payload = await response.text();
    if (!stillCurrent()) return null;
    return parseSuggestions(payload, text);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Request identity is the surface's request id, not a global sequence, so a
 *  late answer for an old query cannot paint over a newer one. */
const _newtabRequests = new Map();
let _launcherRequest = "";
let _sequence = 0;

function newtabToken(session, requestId) {
  return `${session}\u0000${requestId}\u0000${++_sequence}`;
}

function emitSearch({ context, query, results, pending }) {
  emit("search-changed", {
    pending,
    context,
    query,
    completion: null,
    results,
  });
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
   * Answer a New Tab query. Suggestions are rows ahead of the search row, in
   * the order the provider offered them; the search row is always last and is
   * what Enter uses when no suggestion is chosen.
   */
  async newtabSearch({ query = "", context = null } = {}) {
    const text = String(query ?? "").trim();
    const owner = context ?? (await Search.newtabContext({}));
    const current = engine();
    const rows = text === "" ? [] : [searchRow(text, current)];
    const requestId = String(owner.request_id ?? "");
    const session = String(owner.session_id ?? "newtab:tab");
    const echoed = { ...owner, request_id: requestId };
    const token = newtabToken(session, requestId);
    _newtabRequests.set(session, token);

    const wantsSuggestions =
      text !== "" && bang(text) === null && suggestionsEnabled();
    if (!wantsSuggestions) {
      emitSearch({ context: echoed, query: text, results: rows, pending: false });
      return true;
    }

    // The search row is usable at once; the suggestion rows arrive ahead of it
    // when the provider answers, and never replace it.
    emitSearch({ context: echoed, query: text, results: rows, pending: true });
    const suggestions = await fetchSuggestions(
      text,
      current,
      () => _newtabRequests.get(session) === token,
    );
    if (_newtabRequests.get(session) !== token) return true;
    const results = suggestions?.length
      ? [...suggestions.map((suggestion) => suggestionRow(suggestion, current)), ...rows]
      : rows;
    emitSearch({ context: echoed, query: text, results, pending: false });
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
    const tab = __tabsState().selectedId;
    if (tab) {
      await Navigation.loadURL({ astra_tab_id: tab, url: resolved.url });
      return { operation_id: null, accepted: true };
    }
    await Tabs.create({ url: resolved.url, background: false });
    return { operation_id: null, accepted: true };
  },

  async newtabCancel({ context = null } = {}) {
    const session = context?.session_id;
    if (typeof session === "string" && session !== "") {
      _newtabRequests.delete(session);
    }
    return true;
  },

  /** `browser_open_url`: the window has no page to type into, so the address
   *  goes to a tab — the same resolution, so search works there too. */
  async openUrl({ url = "", new_tab = false } = {}) {
    const resolved = resolve(url);
    if (!resolved) return { operation_id: null, accepted: false };
    const tab = new_tab ? "" : __tabsState().selectedId;
    if (tab) {
      const result = await Navigation.loadURL({ astra_tab_id: tab, url: resolved.url });
      return { operation_id: null, accepted: !result.error };
    }
    await Tabs.create({ url: resolved.url, background: false });
    return { operation_id: null, accepted: true };
  },

  /**
   * The launcher's query. Local results belong to native; the rows this
   * module adds are the provider's suggestions followed by the web search.
   */
  async launcherSearch({ query = "", requestId = "" } = {}) {
    const text = String(query ?? "").trim();
    const current = engine();
    const rows = text === "" ? [] : [searchRow(text, current)];
    const token = String(requestId || `launcher-${++_sequence}`);
    _launcherRequest = token;

    const wantsSuggestions =
      text !== "" && bang(text) === null && suggestionsEnabled();
    if (!wantsSuggestions) {
      emitSearch({ context: null, query: text, results: rows, pending: false });
      return true;
    }

    emitSearch({ context: null, query: text, results: rows, pending: true });
    const suggestions = await fetchSuggestions(
      text,
      current,
      () => _launcherRequest === token,
    );
    if (_launcherRequest !== token) return true;
    const results = suggestions?.length
      ? [...suggestions.map((suggestion) => suggestionRow(suggestion, current)), ...rows]
      : rows;
    emitSearch({ context: null, query: text, results, pending: false });
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

/** Test-only reset for request identity. */
export function __resetSearchForTests() {
  _newtabRequests.clear();
  _launcherRequest = "";
  _sequence = 0;
}
