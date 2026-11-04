/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API PageSource module (P8). The app's Source page asks for the text of
// the page in front. The tab model keeps no document, so the chrome shell
// installs a driver that reads the page through the engine; this module owns
// the request shape, bounds and failure behaviour.
//
// The driver is the only engine-specific part and is deliberately injected:
//   driver(tab_id) -> { url, text } | null
// A missing driver is an honest null (the UI keeps "document no longer held"),
// never an empty page.
//
// Pure logic, no Firefox internals: the chrome shell and Node contract tests
// import the same module.

/** Matches the shell's previous fetch bound; the Source page renders it. */
export const MAX_SOURCE_CHARS = 2_000_000;

let _driver = null;

/** Install (or clear) the engine read. The shell owns the lifetime. */
export function setDriver(driver) {
  _driver = typeof driver === "function" ? driver : null;
}

/**
 * Read the source of one Astra tab.
 *
 * Returns `{ url, text, truncated }` or `null` when there is no driver, no
 * tab id, or the engine could not read the document. Never throws into the
 * bridge.
 */
export async function pageSource({ tab_id = "" } = {}) {
  if (!_driver) return null;
  if (typeof tab_id !== "string" || tab_id === "") return null;
  let result = null;
  try {
    result = await _driver(tab_id);
  } catch {
    return null;
  }
  if (!result || typeof result !== "object") return null;
  const url = typeof result.url === "string" ? result.url : "";
  const text = typeof result.text === "string" ? result.text : "";
  return {
    url,
    text: text.length > MAX_SOURCE_CHARS ? text.slice(0, MAX_SOURCE_CHARS) : text,
    truncated: result.truncated === true || text.length > MAX_SOURCE_CHARS,
  };
}

export const PageSource = { pageSource, setDriver };

/** Test-only: drop the injected driver. */
export function __resetPageSourceForTests() {
  _driver = null;
}
