/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API TabHistory module. The Back/Forward menu lists the pages behind
// and ahead of the one in front, and the engine's session history is the only
// honest source: the model's stack holds addresses, not the titles or the
// entries the engine actually kept.
//
// The driver is the only engine-specific part and is deliberately injected:
//   driver.list(astra_tab_id) -> { index, entries: [{ url, title }] } | null
// A missing driver is an empty list (the menu simply does not open), never an
// invented page.
//
// Pure logic, no Firefox internals: the chrome shell and Node contract tests
// import the same module.

/** The menu shows a window of entries; this is the whole read's bound. */
export const MAX_HISTORY_ENTRIES = 50;

let _driver = null;

/** Install (or clear) the engine read. The shell owns the lifetime. */
export function setDriver(driver) {
  _driver = driver && typeof driver.list === "function" ? driver : null;
}

/** One sanitised entry: both fields are strings, never undefined. */
function entryOf(raw) {
  return {
    url: typeof raw?.url === "string" ? raw.url : "",
    title: typeof raw?.title === "string" ? raw.title : "",
  };
}

/**
 * Read the session history of one Astra tab.
 *
 * Returns `{ index, entries }` where `index` always points at an entry (or 0
 * for an empty list). Never throws into the bridge.
 */
export async function list({ astra_tab_id = "" } = {}) {
  const empty = { index: 0, entries: [] };
  if (!_driver) return empty;
  if (typeof astra_tab_id !== "string" || astra_tab_id === "") return empty;
  let raw = null;
  try {
    raw = await _driver.list(astra_tab_id);
  } catch {
    return empty;
  }
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.entries)) return empty;

  let entries = raw.entries.map(entryOf);
  let index = Number.isInteger(raw.index) ? raw.index : entries.length - 1;
  // Keep the most recent entries: the current page must stay in the window.
  if (entries.length > MAX_HISTORY_ENTRIES) {
    const dropped = entries.length - MAX_HISTORY_ENTRIES;
    entries = entries.slice(dropped);
    index -= dropped;
  }
  if (entries.length === 0) return empty;
  index = Math.min(entries.length - 1, Math.max(0, index));
  return { index, entries };
}

export const TabHistory = { list, setDriver };

/** Test-only: drop the injected driver. */
export function __resetTabHistoryForTests() {
  _driver = null;
}
