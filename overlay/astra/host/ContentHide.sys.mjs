/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was obtained with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Element hiding for the Content actor (P4-T03). Pure logic, no browser
// internals: importable both as a chrome ES module
// (`resource://astra/host/ContentHide.sys.mjs`) and from Node contract
// tests. The live shell owns DOM injection (content scripts / frame
// scripts); this module owns selector resolution, application, the
// click-to-hide picking flow, and per-site rule persistence.
//
// Two rule sources:
//   1. Cosmetic filters: `astra-blocker`'s `cosmetic_selectors(url,
//      classes, ids)` (crates/astra-blocker, merged). The caller collects
//      observed classes/ids via `collectObserved` and asks again as more
//      appear (e.g. on DOM mutations).
//   2. Click-to-hide overrides: per-site selectors confirmed by the user.
//      Persisted through an injectable store adapter. The production
//      adapter maps onto the existing `blocker_overrides` table
//      (P2-T04, crates/astra-store) via `blocker_override_set(host,
//      action)` with `action = "cosmetic-hide:<selector>"` — referenced,
//      never reschemaed here.
//
// Traversal covers same-origin iframes (`contentDocument`) and open
// shadow roots, so one `applySelectors` call hides across the static,
// iframe, and shadow-DOM fixtures.

import { emit as defaultEmit } from "./Events.sys.mjs";

export const HOST_API_VERSION = 1;
export const HIDE_ATTR = "data-astra-hide";
const MAX_SELECTOR_LEN = 1024;

// --- Injectable seams (live shell wires the real ones) ------------------
let _emitSink = (type, data) => defaultEmit(type, data);
// Cosmetic provider: { cosmeticSelectors(url, classes, ids) }. Defaults
// to "no filters" so contract tests run without the blocker engine.
let _cosmetic = { cosmeticSelectors: () => [] };
// Store adapter: { load(host) -> string[], save(host, selectors) -> void }.
// Defaults to an in-memory map; production maps onto `blocker_overrides`.
const _memoryStore = new Map();
let _store = {
  load: (host) => [...(_memoryStore.get(host) ?? [])],
  save: (host, selectors) => {
    _memoryStore.set(host, [...selectors]);
  },
};

export function setEventSink(fn) {
  _emitSink = fn;
}

export function setCosmeticProvider(provider) {
  _cosmetic = provider;
}

export function setStoreAdapter(adapter) {
  _store = adapter;
}

// --- Host + selector helpers --------------------------------------------
export function normalizeHost(host) {
  return String(host ?? "")
    .trim()
    .replace(/\.$/, "")
    .toLowerCase();
}

export function hostOfUrl(url) {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return "";
  }
}

function envelope(request_id, extra = {}) {
  return { request_id, host_api_version: HOST_API_VERSION, ...extra };
}

function failure(request_id, code, message) {
  return envelope(request_id, { error: { code, message } });
}

export function isValidSelector(selector) {
  if (typeof selector !== "string") {
    return false;
  }
  const trimmed = selector.trim();
  if (trimmed === "" || trimmed.length > MAX_SELECTOR_LEN) {
    return false;
  }
  // Never allow markup or script-smuggling inside a stored rule.
  if (/[<>"`]|javascript:/i.test(trimmed)) {
    return false;
  }
  return true;
}

// Build a stable selector for a clicked element (click-to-hide): prefer
// `#id`, then the first class, else a tag path. Pure over duck-typed
// elements so fake-DOM contract tests can drive it.
export function selectorForElement(el) {
  if (!el) {
    return "";
  }
  if (el.id) {
    return `#${el.id}`;
  }
  const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
  if (cls) {
    return `.${cls}`;
  }
  const tag = (el.tagName || el.tag || "div").toLowerCase();
  if (el.parentNode && typeof el.parentNode.tagName === "string") {
    const parent = (el.parentNode.tagName || "div").toLowerCase();
    return `${parent} > ${tag}`;
  }
  return tag;
}

// One `display:none` stylesheet for a selector list (injected by the
// live shell; kept here so content scripts and tests share the text).
export function buildStylesheet(selectors) {
  return selectors
    .filter((s) => isValidSelector(s))
    .map((s) => `${s.trim()}{display:none!important;}`)
    .join("\n");
}

// --- Document traversal (iframes + shadow DOM) ---------------------------
// Yields every document-like scope reachable from `doc`: itself, each
// same-origin iframe `contentDocument` (recursively), and every open
// shadow root found by walking element subtrees.
export function* scopesOf(doc) {
  if (!doc) {
    return;
  }
  yield doc;
  const roots = [doc];
  if (typeof doc.querySelectorAll === "function") {
    for (const el of doc.querySelectorAll("*")) {
      if (el.shadowRoot) {
        roots.push(el.shadowRoot);
        yield el.shadowRoot;
      }
      const child = el.contentDocument;
      if (child && child !== doc) {
        yield* scopesOf(child);
      }
    }
    // Iframes whose contentDocument is not exposed as an element
    // property in some embeddings: also scan explicit frames lists.
    for (const frame of doc.frames ?? []) {
      if (frame && frame.document && frame.document !== doc) {
        yield* scopesOf(frame.document);
      }
    }
  }
  void roots;
}

function splitSelectorList(selector) {
  return selector
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

// Collect observed classes/ids across all scopes to feed the blocker's
// generic cosmetic lookup (`cosmetic_selectors` matches generic rules
// against exactly these).
export function collectObserved(doc) {
  const classes = new Set();
  const ids = new Set();
  for (const scope of scopesOf(doc)) {
    if (typeof scope.querySelectorAll !== "function") {
      continue;
    }
    for (const el of scope.querySelectorAll("*")) {
      if (el.id) {
        ids.add(el.id);
      }
      const cls = typeof el.className === "string" ? el.className : "";
      for (const token of cls.trim().split(/\s+/)) {
        if (token) {
          classes.add(token);
        }
      }
    }
  }
  return { classes: [...classes].sort(), ids: [...ids].sort() };
}

// Hide every element matching `selectors` in every scope. Marks hits with
// `data-astra-hide="1"` (idempotent: already-marked nodes are skipped)
// and sets `display:none`. Returns `{ hidden }`.
export function applySelectors(doc, selectors) {
  const list = (Array.isArray(selectors) ? selectors : [])
    .flatMap(splitSelectorList)
    .filter(isValidSelector);
  let hidden = 0;
  for (const scope of scopesOf(doc)) {
    if (typeof scope.querySelectorAll !== "function") {
      continue;
    }
    for (const sel of list) {
      let nodes = [];
      try {
        nodes = scope.querySelectorAll(sel);
      } catch {
        continue;
      }
      for (const el of nodes) {
        try {
          if (el.getAttribute && el.getAttribute(HIDE_ATTR) === "1") {
            continue;
          }
          if (el.setAttribute) {
            el.setAttribute(HIDE_ATTR, "1");
          }
          if (el.style) {
            el.style.display = "none";
          }
          hidden += 1;
        } catch {
          // One hostile node must not abort the sweep.
        }
      }
    }
  }
  return { hidden };
}

// One-shot cosmetic pass: collect observed classes/ids, resolve selectors
// from the blocker provider plus stored per-site overrides, apply them.
// Returns the applied selector list and hidden count.
export async function hideForPage(doc, { request_id = "hide-page", url = "" } = {}) {
  const host = hostOfUrl(url);
  if (!host) {
    return failure(request_id, "invalid_url", "hideForPage requires an http(s) page URL");
  }
  const { classes, ids } = collectObserved(doc);
  let cosmetic = [];
  try {
    cosmetic = (await _cosmetic.cosmeticSelectors(url, classes, ids)) ?? [];
  } catch {
    cosmetic = [];
  }
  let stored = [];
  try {
    stored = (await _store.load(host)) ?? [];
  } catch {
    stored = [];
  }
  const selectors = [...new Set([...cosmetic, ...stored].filter(isValidSelector))].sort();
  const { hidden } = applySelectors(doc, selectors);
  return envelope(request_id, { url, host, selectors, hidden });
}

// --- Click-to-hide picking flow ------------------------------------------
let _picking = false;

export function isPicking() {
  return _picking;
}

export async function startPicking({ request_id = "hide-pick" } = {}) {
  _picking = true;
  _emitSink("content-hide.picking-started", { request_id });
  return envelope(request_id, { picking: true });
}

export async function cancelPicking({ request_id = "hide-pick" } = {}) {
  _picking = false;
  _emitSink("content-hide.picking-cancelled", { request_id });
  return envelope(request_id, { picking: false });
}

// Confirm the user's clicked element as a per-site rule. Accepts either
// an explicit `selector` or an `element` to derive one from. Persists via
// the store adapter and emits `content-hide.rule-added`.
export async function confirmPick({ request_id = "hide-pick", url = "", host = "", selector = "", element = null } = {}) {
  if (!_picking) {
    return failure(request_id, "not_picking", "confirmPick requires startPicking first");
  }
  const site = normalizeHost(host) || hostOfUrl(url);
  if (!site) {
    return failure(request_id, "invalid_host", "confirmPick requires a host or page URL");
  }
  const finalSelector = (selector || (element ? selectorForElement(element) : "")).trim();
  if (!isValidSelector(finalSelector)) {
    return failure(request_id, "invalid_selector", "confirmPick requires a valid CSS selector");
  }
  const current = new Set((await _store.load(site)) ?? []);
  current.add(finalSelector);
  const selectors = [...current].sort();
  await _store.save(site, selectors);
  _picking = false;
  _emitSink("content-hide.rule-added", { request_id, host: site, selector: finalSelector });
  return envelope(request_id, { host: site, selector: finalSelector, selectors });
}

// --- Per-site rule management --------------------------------------------
export async function addRule({ request_id = "hide-rule", host = "", url = "", selector = "" } = {}) {
  const site = normalizeHost(host) || hostOfUrl(url);
  if (!site) {
    return failure(request_id, "invalid_host", "addRule requires a host or page URL");
  }
  if (!isValidSelector(selector)) {
    return failure(request_id, "invalid_selector", "addRule requires a valid CSS selector");
  }
  const current = new Set((await _store.load(site)) ?? []);
  current.add(selector.trim());
  const selectors = [...current].sort();
  await _store.save(site, selectors);
  _emitSink("content-hide.rule-added", { request_id, host: site, selector: selector.trim() });
  return envelope(request_id, { host: site, selectors });
}

export async function removeRule({ request_id = "hide-rule", host = "", url = "", selector = "" } = {}) {
  const site = normalizeHost(host) || hostOfUrl(url);
  if (!site) {
    return failure(request_id, "invalid_host", "removeRule requires a host or page URL");
  }
  const current = new Set((await _store.load(site)) ?? []);
  current.delete(String(selector).trim());
  const selectors = [...current].sort();
  await _store.save(site, selectors);
  _emitSink("content-hide.rule-removed", { request_id, host: site, selector: String(selector).trim() });
  return envelope(request_id, { host: site, selectors });
}

export async function listRules({ request_id = "hide-rule", host = "", url = "" } = {}) {
  const site = normalizeHost(host) || hostOfUrl(url);
  if (!site) {
    return failure(request_id, "invalid_host", "listRules requires a host or page URL");
  }
  const selectors = [...((await _store.load(site)) ?? [])].sort();
  return envelope(request_id, { host: site, selectors });
}

export async function clearSite({ request_id = "hide-rule", host = "", url = "" } = {}) {
  const site = normalizeHost(host) || hostOfUrl(url);
  if (!site) {
    return failure(request_id, "invalid_host", "clearSite requires a host or page URL");
  }
  await _store.save(site, []);
  _emitSink("content-hide.rule-removed", { request_id, host: site, selector: "*" });
  return envelope(request_id, { host: site, selectors: [] });
}

export const ContentHide = {
  hideForPage,
  applySelectors,
  collectObserved,
  selectorForElement,
  buildStylesheet,
  startPicking,
  cancelPicking,
  confirmPick,
  isPicking,
  addRule,
  removeRule,
  listRules,
  clearSite,
  normalizeHost,
  hostOfUrl,
  setCosmeticProvider,
  setStoreAdapter,
  setEventSink,
};

// Test-only reset: clears picking state and the default in-memory store.
// Injected adapters/providers survive (callers re-inject per test).
export function __resetForTests() {
  _picking = false;
  _memoryStore.clear();
}
