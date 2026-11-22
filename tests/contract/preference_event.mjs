#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A preference write answers with a typed event (P7-T05).
//
// The host used to announce a write by emitting the string
// `preference.<key>=<value>` on `ui-command`, and every consumer re-parsed it.
// `Settings.set` now emits one typed `preference_changed` event carrying the
// same key and value. This suite pins three things:
//
//   1. the event is declared on the wire and forwarded to the DOM channel the
//      app listens on (proto -> native-events -> chrome-entry -> wire_coverage);
//   2. a valid write emits exactly one event, with the key and value written;
//   3. a refused write (bad key, or a value with a C0 control) emits nothing.
//
// It also proves the write path does not double-announce when the engine's own
// pref observer sees the same write, which is the case in a live browser.
//
// Usage: node tests/contract/preference_event.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, HOST, check, summary } from "./lib/harness.mjs";

const read = (relative) => readFile(path.join(ROOT, relative), "utf8");
const [proto, bindings, nativeEvents, chromeEntry, wireCoverage] = await Promise.all([
  read("ui/packages/bridge/src/proto.ts"),
  read("ui/app/src/shared/ipc/bindings.ts"),
  read("ui/app/src/shared/ipc/native-events.ts"),
  read("ui/app/chrome-entry/browser-chrome.ts"),
  read("tests/contract/wire_coverage.mjs"),
]);

// --- declared and forwarded ------------------------------------------------
check(
  "proto.ts declares the preference_changed event channel",
  /"preference_changed"/u.test(proto),
);
check(
  "proto.ts lists preference_changed in the EVENTS catalogue",
  /EVENTS: readonly EventChannel\[\] = \[[\s\S]*?"preference_changed"[\s\S]*?\]/u.test(proto),
);
check(
  "bindings.ts types the payload as key + value",
  /export type PreferenceChanged = \{[\s\S]*?key: string,[\s\S]*?value: string,[\s\S]*?\};/u.test(
    bindings,
  ),
);
check(
  "native-events.ts declares the astra:preference-changed channel",
  nativeEvents.includes('preferenceChanged: "astra:preference-changed"'),
);
check(
  "native-events.ts exposes the typed factory",
  /preferenceChanged: scopedEvent<PreferenceChanged>\(/u.test(nativeEvents),
);
check(
  "chrome-entry forwards preference_changed onto the DOM",
  /"preference_changed":\s*"astra:preference-changed"/u.test(chromeEntry),
);
check(
  "wire_coverage.mjs requires astra:preference-changed",
  wireCoverage.includes('"astra:preference-changed"'),
);
check(
  "the string dialect is gone from Settings",
  !(await read("overlay/astra/host/Settings.sys.mjs")).includes("preference.${key}="),
);

// --- the write path --------------------------------------------------------
const events = await import(pathToFileURL(path.join(HOST, "Events.sys.mjs")).href);
const settings = await import(pathToFileURL(path.join(HOST, "Settings.sys.mjs")).href);
const { Settings, __resetSettingsForTests, __setPrefsForTests } = settings;

function collect() {
  const seen = [];
  const stop = events.addEventListener((event) => {
    if (event.type === "preference_changed") seen.push(event.data);
  });
  return { seen, stop };
}

// A pref store that notifies its observers the way nsIPrefService does, so the
// engine-side observer and the explicit write announcement both run.
function fakePrefs() {
  const values = new Map();
  const observers = new Set();
  return {
    values,
    getStringPref(name, fallback) {
      return values.has(name) ? values.get(name) : fallback;
    },
    getBoolPref(name, fallback) {
      return values.has(name) ? values.get(name) : fallback;
    },
    setStringPref(name, value) {
      values.set(name, value);
      for (const observer of observers) observer.observe(null, "nsPref:changed", name);
    },
    setBoolPref(name, value) {
      values.set(name, value);
      for (const observer of observers) observer.observe(null, "nsPref:changed", name);
    },
    getIntPref(_name, fallback) {
      return fallback;
    },
    setIntPref() {},
    addObserver(_domain, observer) {
      observers.add(observer);
    },
    removeObserver(observer) {
      observers.delete(observer);
    },
    getDefaultBranch() {
      return { setStringPref() {}, setIntPref() {}, setBoolPref() {} };
    },
  };
}

// Outside a chrome process: admission falls back to the session value.
events.__resetEventsForTests();
__resetSettingsForTests();
{
  const { seen, stop } = collect();
  const result = await Settings.set({ request_id: "r-1", key: "ui.accent", value: "sage" });
  check("a valid write is admitted", result?.accepted === true);
  check("a valid write emits exactly one event", seen.length === 1, String(seen.length));
  check("the event carries the written key", seen[0]?.key === "ui.accent", String(seen[0]?.key));
  check("the event carries the written value", seen[0]?.value === "sage", String(seen[0]?.value));
  check(
    "the event payload has no other field",
    JSON.stringify(Object.keys(seen[0] ?? {}).sort()) === '["key","value"]',
    JSON.stringify(seen[0]),
  );
  stop();
}

// A refused key is not an event.
{
  const { seen, stop } = collect();
  const result = await Settings.set({ request_id: "r-2", key: "bad key", value: "x" });
  check("an invalid key is refused", result?.accepted === false);
  check("an invalid key emits nothing", seen.length === 0, String(seen.length));
  stop();
}

// A value with a C0 control (other than the list separator) is not an event.
{
  const { seen, stop } = collect();
  const result = await Settings.set({ request_id: "r-3", key: "ntp.wordmark", value: "a\u0007b" });
  check("a control character is refused", result?.accepted === false);
  check("a control character emits nothing", seen.length === 0, String(seen.length));
  stop();
}

// With a real pref store the engine observer also sees the write: one event.
{
  events.__resetEventsForTests();
  __resetSettingsForTests();
  const prefs = fakePrefs();
  __setPrefsForTests(prefs);
  await Settings.get({ key: "ui.accent" }); // attaches the observer
  const { seen, stop } = collect();
  const result = await Settings.set({ request_id: "r-4", key: "ui.accent", value: "rose" });
  check("a write with pref observers is admitted", result?.accepted === true);
  check(
    "the observer and the write path do not double-announce",
    seen.length === 1,
    JSON.stringify(seen),
  );
  check(
    "the event still carries the written key and value",
    seen[0]?.key === "ui.accent" && seen[0]?.value === "rose",
    JSON.stringify(seen[0]),
  );
  check(
    "the value is stored under the Astra branch",
    prefs.values.get("astra.settings.ui.accent") === "rose",
    String(prefs.values.get("astra.settings.ui.accent")),
  );
  stop();
}

events.__resetEventsForTests();
__resetSettingsForTests();
summary("preference event");
